---
description: Pair this PC with your Garmin watch (shows a 6-digit code to enter in Garmin Connect or the phone page)
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/cli/wristgate.js" pair --plugin --detach`

The output above is from the Wristgate command-line tool. Show it to the user exactly as printed, in a code block, and add nothing else unless it reports an error, in which case explain the error in one sentence. If it shows a pairing code, remind them to enter it in Garmin Connect (watch > Connect IQ apps > Wristgate > Settings > Pairing code) or on the Wristgate phone page, and that pairing finishes by itself; they can check with /wristgate:status. Do not run any other commands.
