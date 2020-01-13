module.exports = function(RED) {

    var mqtt = require("mqtt");
    var util = require("util");
    var isUtf8 = require('is-utf8');
    var url = require('url');

    function DatacakeDeviceOutpuNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var globalContext = this.context().global;
        // Retrieve the config node, where the device is configured
        node.datacake_configuration = RED.nodes.getNode(config.datacake_configuration);
        node.log("Datacake - Device Output: Starting Device Output");
        node.device_id = config.device_id;
        node.connected = false;

        if(typeof(config.device_id) !== 'undefined' && config.device_id != ""){
            node.device_id = config.device_id.split("#")[0];
            node.product_slug = config.device_id.split("#")[1];
        } else {
            node.device_id = "";
            node.product_slug = "";
        }
        node.field_id = config.field_id; 
        if(!node.datacake_configuration) {
            node.warn("Datacake - Device Output: No Configuration");
            node.status({fill:"red",shape:"ring",text:"no configuration"});
        } else {
            node.log("Datacake - Device Output: Starting connection");
            node.log("Datacake - Device Output: Device ID: " + node.device_id);
            node.log("Datacake - Device Output: Product Slug " + node.product_slug);
            node.log("Datacake - Device Output: Field Name " + node.field_id);

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
                node.connected = true;
                node.log("Datacake - Device Output: Verbindung erfolgreich.");
                node.status({fill:"green",shape:"dot",text:"connected"});
            });

            node.on('input', function(msg, send, done) {
                let product_slug = "";
                let device_id = "";
                let field_id = "";
                let hasConfiguration = true;
                if(node.product_slug != "" && node.device_id != "") {
                    product_slug = node.product_slug;
                    device_id = node.device_id;
                } else if(msg.payload.productSlug != "" && msg.payload.deviceId != ""){
                    product_slug = msg.payload.productSlug;
                    device_id = msg.payload.deviceId;
                } else {
                    hasConfiguration = false;
                }

                if(node.field_id != ""){
                    field_id = node.field_id;
                } else if(msg.payload.fieldName != ""){
                    field_id = msg.payload.fieldName;
                } else {
                    hasConfiguration = false;
                }

                if(hasConfiguration){
                    var topic = 'dtck-pub/' + product_slug + '/' + device_id + '/' + field_id;
                    client.publish(topic, msg.payload.toString());

                    if (done) {
                        done();
                    }
                    node.log("Datacake - Device Output: Sent Data to " + topic);
                    node.status({fill:"green",shape:"dot",text:"connected"});
                } else {
                    node.log("Datacake - Device Output: Konfiguration fehlerhaft.");
                    node.status({fill:"red",shape:"ring",text:"disconnected"});
                }

            });


            node.on('close', function() {
                client.end()
            });
        }
    }

    RED.nodes.registerType("datacake-device-output", DatacakeDeviceOutpuNode);
}