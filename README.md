# Datacake Node-RED Nodes

[Datacake](https://datacake.co) is a low-code IoT platform focussed on solving
real use-cases with little effort. This repository contains Node-RED nodes
that allow the subscription and publishing of device measurements. They are
also used in [Cake Red](https://datacake.co/cake-red), our hosted & managed
Node-RED offering.

## Development

Install Node-RED globally:

```
npm install -g --unsafe-perm node-red
```

Start Node-RED so that it creates the `~/.node-red` directory:

```
node-red
```

Build the nodes for the first time:

```
yarn run watch
```

Install the nodes:

```
cd ~/.node-red
npm install <location of datacake-nodes>
```

Start Node-RED server:

```
yarn run watch
```

Changes in `.ts` files are hot-reloaded while changes on `.html` files need
a restart of the server.

## Credits

This project uses Typescript types and code from
https://github.com/bernardobelchior/node-red-contrib-typescript-node
