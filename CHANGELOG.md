# Changelog

## 1.0.0

Rewrite for current Node-RED versions. Existing flows keep working; see "Upgrading from 0.x" in the
README.

### Fixed

- MQTT connections were never closed: every full deploy left the old connection, its listeners
  and all old node instances in memory. The old connections kept delivering, so after 100 deploys
  a single value from Datacake produced 101 identical messages in the flow.
- Every node added listeners to the shared connection without removing them, so they piled up
  with each partial deploy.
- Removed nodes stayed subscribed at the broker.
- A `datacake in` node added by a partial deploy did not subscribe until the next reconnect.
- A missing account or token crashed the node with a TypeError.
- Node labels ignored the configured name and never showed device or field.
- `datacake out` could publish to invalid topics (empty device, `+` as field), crashed on empty
  payloads and turned objects into `[object Object]`.

### Changed

- The API token is stored in the encrypted credentials instead of the flow file; tokens of 0.x
  are migrated in the editor.
- The editor no longer calls the Datacake API from the browser; requests go through the
  Node-RED runtime.
- Devices are searched instead of loading the whole workspace.
- Errors of `datacake out` can be handled with a Catch node.
- Requires Node-RED 3.1+ and Node.js 18+; `node-red` is no longer installed as a dependency.

### Added

- Labels `Device › Field`, kept up to date with the names in Datacake.
- Status with connection state and last value.
- `datacake in`: all devices of a product; typed values (number, boolean, text);
  `msg.topic` and `msg.datacake` with device name, field label and unit.
- `datacake out`: device and field from the message (with loop protection), several fields per
  message.
- English and German texts and help, example flows.
