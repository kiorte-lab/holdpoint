---
description: Pair with your Garmin watch, or turn Wristgate on/off. Usage /wristgate pair | status | on | off | unpair
argument-hint: pair | status | on | off | unpair
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/cli/wristgate.js" $ARGUMENTS --plugin --detach`

The output above is from the Wristgate command-line tool. Show it to the user exactly as printed, in a code block, and add nothing else unless it reports an error, in which case explain the error in one sentence. If it shows a pairing code, remind them to enter it in Garmin Connect (watch > Connect IQ apps > Wristgate > Settings > Pairing code) or on the Wristgate phone page, and that pairing finishes by itself. Do not run any other commands.
