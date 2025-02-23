var url = require('url');
var _ = require('lodash');
var middlewareDebugger = require('./middleware-debugger.js');

// add a little bit of middleware that we want available but don't want to automatically include
cac.host = require('./host.js');
cac.referer = require('./referer.js');
cac.cookies = require('./cookies.js');
cac.hsts = require('./hsts.js');
cac.hpkp = require('./hpkp.js');
cac.csp = require('./csp.js');
cac.redirects = require('./redirects.js');
cac.decompress = require('./decompress.js');
cac.charsets = require('./charsets.js');
cac.urlPrefixer = require('./url-prefixer.js');
cac.metaRobots = require('./meta-robots.js');
cac.contentLength = require('./content-length.js');

// these aren't middleware, but are still worth exposing
cac.proxy = require('./proxy.js');
cac.contentTypes = require('./content-types.js');
cac.getRealUrl = require('./get-real-url.js');


function cac(config) {
    _.defaults(config, {
        prefix: '/proxy/',
        host: null, // can be used to override the url used in redirects
        requestMiddleware: [],
        responseMiddleware: [],
        standardMiddleware: true,
        processContentTypes: [
            'text/html',
            'application/xml+xhtml',
            'application/xhtml+xml',
            'text/css'
            /*,
           'text/javascript',
           'application/javascript',
           'application/x-javascript'
            */
        ]
    });

    // html is getting through but images are choking, and js only makes it when not run through urlPrefixStream

    if (config.prefix.substr(-1) != '/') {
        config.prefix += '/';
    }

    if (config.standardMiddleware !== false) {

        var host = cac.host(config);
        var referer = cac.referer(config);
        var cookies = cac.cookies(config);
        var hsts = cac.hsts(config);
        var hpkp = cac.hpkp(config);
        var csp = cac.csp(config);
        var redirects = cac.redirects(config);
        var decompress = cac.decompress(config);
        var charsets = cac.charsets(config);
        var urlPrefixer = cac.urlPrefixer(config);
        var metaRobots = cac.metaRobots(config);
        var contentLength = cac.contentLength(config);

        config.requestMiddleware = [
            host,
            referer,
            decompress.handleRequest,
            cookies.handleRequest
        ].concat(config.requestMiddleware);

        config.responseMiddleware = [
            hsts,
            hpkp,
            csp,
            redirects,
            decompress.handleResponse,
            charsets,
            urlPrefixer,
            cookies.handleResponse,
            metaRobots
        ].concat(config.responseMiddleware, [
            contentLength
        ]);
    }

    // todo: check if config.debug is enabled first
    if (middlewareDebugger.enabled) {
        config.requestMiddleware = middlewareDebugger.debugMiddleware(config.requestMiddleware, 'request');
        config.responseMiddleware = middlewareDebugger.debugMiddleware(config.responseMiddleware, 'response');
    }


   

    var proxy = cac.proxy(config);

    var getRealUrl = cac.getRealUrl(config);

    function handleRequest(clientRequest, clientResponse, next) {

        // default to express's more advanced version of this when available (handles X-Forwarded-Protocol headers)
        clientRequest.protocol = clientRequest.protocol || clientRequest.connection.encrypted ? 'https' : 'http';

        // convenience methods
        clientRequest.thisHost = thisHost.bind(thisHost, clientRequest);
        clientRequest.thisSite = thisSite.bind(thisSite, clientRequest);
        clientResponse.redirectTo = redirectTo.bind(redirectTo, clientRequest, clientResponse);

        if (!next) {
            next = function() {
                clientResponse.redirectTo("");
            };
        }

        var url_data = url.parse(clientRequest.url);


        // only requests that start with this get proxied - the rest get
        // redirected to either a url that matches this or the home page
        if (url_data.pathname.indexOf(config.prefix + "http") === 0) {

            var uri = url.parse(getRealUrl(clientRequest.url));

            // redirect urls like /proxy/http://asdf.com to /proxy/http://asdf.com/ to make relative image paths work
            var formatted = url.format(uri);
            if (formatted != clientRequest.url.substr(config.prefix.length)) {
                return clientResponse.redirectTo(formatted);
            }

            // this is how api consumers can hook into requests. The data object is passed to all requestMiddleware before the request is sent to the remote server, and it is passed through all responseMiddleware before being sent to the client.
            var data = {
                url: url.format(uri),
                clientRequest: clientRequest,
                clientResponse: clientResponse,
                headers: _.cloneDeep(clientRequest.headers),
                stream: clientRequest
            };
            data['headers']['X-Real-IP'] = ''
            data['headers']['X-Forwarded-For'] = ''
            proxy(data, next);
        } else {
            // any other url gets redirected to the correct proxied url if we can
            // determine it based on their referrer, or passed back to express (or whatever) otherwise
            handleUnknown(clientRequest, clientResponse, next);
        }

    }

    /**
     * This is what makes this server magic: if we get an unrecognized request that wasn't corrected by
     * proxy's filter, this checks the referrer to determine what the path should be, and then issues a
     * 307 redirect to a proxied url at that path
     *
     * todo: handle querystring and post data
     */
    function handleUnknown(request, response, next) {

        if (request.url.indexOf(config.prefix) === 0) {
            // handles /proxy/ and /proxy
            if (request.url == config.prefix || request.url == config.prefix.substr(0, config.prefix.length - 1)) {
                return response.redirectTo("");
            }
            // handles cases like like /proxy/google.com and redirects to /proxy/http://google.com/
            return response.redirectTo("http://" + request.url.substr(config.prefix.length));
        }

        // if there is no referer, then either they just got here or we can't help them
        if (!request.headers.referer) {
            return next(); // in express apps, this will let it try for other things at this url. Otherwise, it just redirects to the home page
        }

        var ref = url.parse(request.headers.referer);

        // if we couldn't parse the referrer or they came from another site, they send them to the home page
        if (!ref || ref.host != thisHost(request)) {
            return next();
        }

        // now we know where they came from, so we can do something for them
        if (ref.pathname.indexOf(config.prefix + 'http') === 0) {
            var real_url = getRealUrl(ref.pathname);
            var real_uri = url.parse(real_url);
            var target_url = real_uri.protocol + "//" + real_uri.host + request.url;
           
            // now, take the requested pat on the previous known host and send the user on their way
            // todo: make sure req.url includes the querystring
            return response.redirectTo(target_url);
        }

        // fallback - there was a referer, but it wasn't one that we could use to determine the correct path
        next();
    }

    // returns the configured host if one exists, otherwise the host that the current request came in on
    function thisHost(request) {
        if (config.host) {
            return config.host;
        } else {
            return request.headers.host; // normal case: include the hostname but assume we're either on a standard port or behind a reverse proxy
        }
    }

    // returns the http://site.com/proxy
    function thisSite(request) {
        // todo: return https when appropriate
        // return request.protocol + '://' + thisHost(request) + config.prefix;
		return 'https://' + thisHost(request) + config.prefix;
    }

    function redirectTo(request, response, site, headers) {
        site = site || "";
        if (site.substr(0, 1) == "/") {
            site = site.substr(1);
        }
        if (site.substr(0, config.prefix.length) == config.prefix) { // no /proxy/proxy redirects
            site = site.substr(config.prefix.length);
        }
        var location = request.thisSite() + site;
        try {
            response.writeHead(307, _.defaults(headers || {}, {
                'Location': location
            }));
        } catch (ex) {
            // the headers were already sent - we can't redirect them
            console.error("Failed to send redirect", ex);
        }
        response.end();
    }

    return handleRequest;
}

module.exports = cac;
