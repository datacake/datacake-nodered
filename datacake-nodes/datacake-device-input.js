module.exports = function(RED) {

    var mqtt = require("mqtt");
    var util = require("util");
    var isUtf8 = require('is-utf8');
    var url = require('url');

    function DatacakeDeviceInputNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var globalContext = this.context().global;
        // Retrieve the config node, where the device is configured
        node.datacake_configuration = RED.nodes.getNode(config.datacake_configuration);
        node.log("Datacake - Device Input: Starting Device Input");
        node.device_id = config.device_id;
        if(typeof(config.device_id) !== 'undefined' && config.device_id != ""){
            node.device_id = config.device_id.split("#")[0];
            node.product_slug = config.device_id.split("#")[1];
        } else {
            node.device_id = "";
            node.product_slug = "";
        }
        node.field_id = config.field_id;
        if(!node.datacake_configuration) {
            node.warn("Datacake - Device Input: No Configuration");
            node.status({fill:"red",shape:"ring",text:"no configuration"});
        } else {
            node.log("Datacake - Device Input: Starting connection");
            node.log("Datacake - Device Input: Device ID: " + node.device_id);
            node.log("Datacake - Device Input: Product Slug " + node.product_slug);
            node.log("Datacake - Device Input: Field Name " + node.field_id);

            var globalVariable = 'mqtt_client' + node.datacake_configuration.workspace_id;

            if(typeof(globalContext.get(globalVariable)) === 'undefined'){
                var client = mqtt.connect('mqtt://mqtt.datacake.co',
                {
                    port: 1883,
                    username: node.datacake_configuration.api_token,
                    password: node.datacake_configuration.api_token,
                });
                globalContext.set(globalVariable, client);
            } else {
                var client = globalContext.get(globalVariable);
            }

            client.on('connect', function () {
                var topic = 'dtck/' + node.product_slug + '/' + node.device_id + '/' + node.field_id;
                client.subscribe(topic, function (err) {
                    if(err){
                        node.log("Datacake - Device Input: Verbindungs Fehler - Konfiguration überprüfen");
                        node.status({fill:"red",shape:"ring",text:"disconnected"});
                    } else {
                        node.log("Datacake - Device Input: Verbindung erfolgreich.");
                        node.log("Datacake - Device Input: Subscribe to " + topic );
                        node.status({fill:"green",shape:"dot",text:"connected"});
                    }
                })
            })


            client.on('message', function (topic, message) {
                node.send(
                    {
                        payload : message.toString(),
                        deviceId: node.device_id,
                        fieldName: node.field_id
                    }
                );

            });

            node.on('close', function() {
                client.end()
            });
        }
    }

    RED.nodes.registerType("datacake-device-input", DatacakeDeviceInputNode);
}