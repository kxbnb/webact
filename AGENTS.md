# WebAct

This repo provides a browser automation skill using the Chrome DevTools Protocol.

## Skills

The `webact` skill is in `skills/webact/`. It lets you control any Chromium-based browser (Chrome, Edge, Brave, Arc, etc.) to accomplish goals like navigating pages, filling forms, clicking elements, and reading content.

## Setup

No setup required - all dependencies are bundled.

## Sandbox Note

The CDP tool launches Chrome on an automatically discovered free port. The port is printed in the launch output and saved in the session state. If your agent sandbox blocks local network access, you'll need to allow connections to `127.0.0.1` on the assigned port.
