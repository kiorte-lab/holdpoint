import Toybox.Application;
import Toybox.Background;
import Toybox.Lang;
import Toybox.Time;
import Toybox.WatchUi;

(:background :glance)
class HoldpointApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        // Check the relay every 5 minutes (the most Connect IQ allows) so the glance
        // stays current and the watch can nudge you when something is waiting.
        if (Background has :registerForTemporalEvent) {
            Background.registerForTemporalEvent(new Time.Duration(5 * 60));
        }
        var view = new MainView();
        return [view, new MainDelegate(view)];
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
        }
        WatchUi.requestUpdate();
    }
}
