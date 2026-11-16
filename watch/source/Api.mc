import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;

// Shared by the app, the glance and the background service.
(:background :glance)
module Api {
    function relay() as String {
        var u = Application.Properties.getValue("relayUrl");
        if (u == null || !(u instanceof String) || (u as String).length() == 0) {
            return "https://wristgate-relay.kiorte.workers.dev";
        }
        return u as String;
    }

    function token() as String? {
        var t = Application.Properties.getValue("token");
        if (t == null || !(t instanceof String) || (t as String).length() == 0) {
            return null;
        }
        return t as String;
    }

    function request(method, path as String, body, callback) as Void {
        var headers = { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON };
        var t = token();
        if (t != null) {
            headers["Authorization"] = "Bearer " + t;
        }
        var options = {
            :method => method,
            :headers => headers,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        };
        Communications.makeWebRequest(relay() + path, body, options, callback);
    }
}
