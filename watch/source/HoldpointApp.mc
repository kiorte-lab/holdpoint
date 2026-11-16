import Toybox.Application;
import Toybox.Background;
import Toybox.Lang;
import Toybox.Time;
import Toybox.WatchUi;

(:background :glance)
class HoldpointApp extends Application.AppBase {
    var view = null;
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        Api.migrate();
        // Check the relay every 5 minutes (the most Connect IQ allows) so the glance
        // stays current and the watch can nudge you when something is waiting.
        if (Background has :registerForTemporalEvent) {
            Background.registerForTemporalEvent(new Time.Duration(5 * 60));
        }
        view = new MainView();
        return [view, new MainDelegate(view as MainView)];
    }

    (:glance)
    function getGlanceView() {
        return [new HoldpointGlance()];
    }

    function getServiceDelegate() {
        return [new HoldpointService()];
    }

    function onBackgroundData(data) {
        if (data instanceof Number) {
            Application.Properties.setValue("lastCount", data);
        } else if (data instanceof Dictionary) {
            // The background service claimed a pairing code typed into Garmin Connect.
            Application.Properties.setValue("lastCount", data["count"]);
            Application.Properties.setValue("pairingCode", "");
            if (data["claimed"] instanceof String && (data["claimed"] as String).length() > 0) {
                Application.Properties.setValue("pairNotice", data["claimed"]);
            }
        }
        WatchUi.requestUpdate();
    }

    // Settings saved in Garmin Connect while the app is open: act on them straight away.
    function onSettingsChanged() as Void {
        if (view != null) { (view as MainView).syncSettings(); }
        WatchUi.requestUpdate();
    }
}
