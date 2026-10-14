# Datacake nodes for Node-RED

[Datacake](https://datacake.co) is a low-code IoT platform. These nodes connect Node-RED to the
Datacake MQTT broker, so flows can react to device measurements in real time and write values
back to devices. They are also used in [Cake Red](https://datacake.co/cake-red), the hosted and
managed Node-RED offering of Datacake.

- **datacake in** receives the values of one device, or of all devices of a product.
- **datacake out** writes values to a device, one field or several fields per message.
- **datacake-configuration** holds the API token and workspace. All nodes of one account share a
  single MQTT connection.

Nodes show the device and field they are connected to, for example `Cold Room 3 › Temperature`,
and their status shows the connection state and the last value.

## Requirements

- Node-RED 3.1 or later
- Node.js 18 or later

## Installation

In Node-RED, open _Manage palette_ and install `node-red-contrib-datacake`, or run in your
Node-RED user directory (usually `~/.node-red`):

```sh
npm install node-red-contrib-datacake
```

## Setup

1. Create an API token in Datacake: _Account Settings → API Token_, or better an API user with
   limited permissions (_Members → API Users_).
2. Add a `datacake in` or `datacake out` node, open it and add a new account. Paste the token and
   pick the workspace.
3. Pick the device (searchable) and the field.

The token is stored in the encrypted credentials of Node-RED, not in the flow file. The editor
never talks to Datacake directly; it asks the Node-RED runtime, which uses the stored token.

Example flows are available in Node-RED under _Import → Examples → node-red-contrib-datacake_.

## datacake in

| Option | Meaning                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Source | _One device_, or _All devices of a product_                                                                             |
| Field  | one field, or all fields                                                                                                |
| Values | _Typed_ converts numbers and booleans according to the field type in Datacake; _Always text_ keeps every value a string |

Output message:

```js
{
  payload: 4.2,                       // number, boolean or string
  topic: "dtck/cold-room/<device id>/TEMPERATURE",
  deviceId: "<device id>",
  productSlug: "cold-room",
  fieldName: "TEMPERATURE",
  datacake: {
    deviceId, deviceName: "Cold Room 3",
    productSlug, productName: "Cold Room Sensor",
    fieldName, fieldLabel: "Temperature", unit: "°C",
    topic
  }
}
```

Names, labels and units are looked up once per device and cached; if the Datacake API is not
reachable the message is sent without them.

## datacake out

| Option | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| Target | _Fixed device_, or _Device from msg.deviceId_ (`msg.productSlug` is optional, it is looked up) |
| Field  | _Fixed field_, _Field from msg.fieldName_, or _Several fields from msg.payload_                |

With _Several fields from msg.payload_, send an object:

```js
msg.payload = { TEMPERATURE: 21.5, HUMIDITY: 48 };
```

Every key is published as its own MQTT message to `dtck-pub/<product>/<device>/<FIELD>`. Keys
that are not fields of the device are skipped with a warning; `temperature` is matched to
`TEMPERATURE`.

When device or field come from the message, a message that comes straight from a `datacake in`
node is never written back to the device and field it was read from. Datacake would publish the
value again and the flow would loop forever.

Errors (not connected, invalid payload, unknown device) are reported through the node and can be
handled with a Catch node.

## Upgrading from 0.x

Version 1.0 is a drop-in replacement. Existing flows keep working without changes:

- **Token:** 0.x stored the API token in plain text in the flow file. 1.0 still reads it, and the
  editor offers to move it to the encrypted credentials (a notification after loading the flows,
  or when the account is opened). Deploy once to complete the move.
- **Values:** existing `datacake in` nodes keep emitting strings. Choose _Typed_ in a node to get
  numbers and booleans. New nodes are typed by default.
- **Labels:** nodes show device and field names right away. Names are loaded from Datacake when
  the editor opens, without changing the flow. Saving a node stores the names in the flow as a
  fallback.
- **datacake out:** 0.x offered _Pass deviceId in msg object_ and _All Measurements_ but ignored
  the message since 0.1.6. 1.0 handles them again as _Device from msg.deviceId_ and _Field from
  msg.fieldName_, protected against loops.
- **Messages** keep `payload`, `deviceId`, `productSlug` and `fieldName`; `topic` and
  `msg.datacake` are new.
- **Fixed:** connections and listeners are no longer leaked on deploy (0.x opened a new connection
  with every full deploy and delivered each value once per connection), removed nodes unsubscribe
  their topics, nodes added by a partial deploy receive values immediately, and missing
  accounts no longer crash the flow.

## Development

```sh
npm install
npm run build   # compile TypeScript and copy the editor files to dist/
npm test        # unit and integration tests (in-process MQTT broker, fake Datacake API)
npm run lint
```

Try the nodes in a local Node-RED:

```sh
npm run build
cd ~/.node-red && npm install <path to this repository>
node-red
```

Runtime code is in `src/*.ts` and `src/lib/`, the editor in `src/*.html`, texts and help in
`src/locales/`. After changes to `.ts` files run `npm run build` (or `npm run watch`) and restart
Node-RED; after changes to `.html` files reload the editor too.

For tests the broker and API can be replaced with the environment variables `DATACAKE_MQTT_URL`
and `DATACAKE_API_URL`.

## Releasing

Releases are published to npm by GitHub Actions through
[trusted publishing](https://docs.npmjs.com/trusted-publishers), no npm token is stored in the
repository. Bump `version` in `package.json`, update `CHANGELOG.md`, merge to `master`, then push a
matching tag:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

## License

MIT
