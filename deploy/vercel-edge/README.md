# Nexus edge

Vercel fronts the Nexus gateway so the onboarding page has a public HTTPS
address without a registered domain. Everything is rewritten to the control
plane host; nothing is served from Vercel itself.

The control plane cannot run on Vercel: runtime-manager holds a Feishu long
connection and an idle-collector timer, neither of which survives a
serverless invocation. The dev target is the Mirror V Lighthouse host. Its
runtime-manager and central-gateway listen on loopback and Nginx exposes only
the portal routes. Deploy this rewrite only after the Mirror V health and
onboarding smoke checks pass.

Replace the destination host when the control plane moves, and drop this
project entirely once a registered domain terminates TLS directly.
