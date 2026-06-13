# Renders the RAIF demo to MP4 + GIF. Rebuild from the repo root with:
#   vhs assets/raif-demo.tape
# (requires `bun` on PATH and the prototype deps installed: cd prototype && bun install)
Output "assets/raif-demo.mp4"
Output "assets/raif-demo.gif"

Set Shell "bash"
Set FontSize 22
Set Width 1360
Set Height 820
Set Padding 28
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "export DEMO_CUES=/tmp/raif-cues.json"
Enter
Type "cd prototype"
Enter
Type "clear"
Enter
Show

Type "bun demo"
Sleep 700ms
Enter
Sleep 47s
