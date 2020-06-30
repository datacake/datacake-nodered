module.exports = function (RED) {
  var mqtt = require("mqtt");
  var util = require("util");
  var isUtf8 = require("is-utf8");
  var url = require("url");

  function DatacakeDeviceInputNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    var globalContext = this.context().global;
    // Retrieve the config node, where the device is configured
    node.datacake_configuration = RED.nodes.getNode(
      config.datacake_configuration
    );
    node.log("Datacake - Device Input: Starting Device Input");
    node.device_id = config.device_id;

    if (typeof config.device_id !== "undefined" && config.device_id != "") {
      node.device_id = config.device_id.split("#")[0];
      node.product_slug = config.device_id.split("#")[1];
    } else {
      node.device_id = "";
      node.product_slug = "";
    }
    node.field_id = config.field_id;
    if (!node.datacake_configuration) {
      node.warn("Datacake - Device Input: No Configuration");
      node.status({ fill: "red", shape: "ring", text: "no configuration" });
    } else {
      node.log("Datacake - Device Input: Starting connection");
      node.log("Datacake - Device Input: Device ID: " + node.device_id);
      node.log("Datacake - Device Input: Product Slug " + node.product_slug);
      node.log("Datacake - Device Input: Field Name " + node.field_id);

      // check number of mqtt connections
      // X nodes share one mqtt connection per workspace, so we keep the EventEmitter limit in check, adjust this number for performance
      // greater number of nodesPerConnection means less strain on the mqtt connection, but greater strain on device running code
      var nodesPerConnection = 5;

      node.globalCountVariable =
        "mqtt_client_" + node.datacake_configuration.workspace_id + "_count";
      if (typeof globalContext.get(node.globalCountVariable) === "undefined") {
        var globalCount = 1;
      } else {
        var globalCount = globalContext.get(node.globalCountVariable);
        globalCount++;
      }
      globalContext.set(node.globalCountVariable, globalCount);

      node.connectionNumber = Math.ceil(globalCount / nodesPerConnection);
      node.globalNodeCountVariable =
        "mqtt_client_" +
        node.datacake_configuration.workspace_id +
        "_count_" +
        node.connectionNumber;
      if (
        typeof globalContext.get(node.globalNodeCountVariable) === "undefined"
      ) {
        var nodeCount = 1;
      } else {
        var nodeCount = globalContext.get(node.globalNodeCountVariable);
        nodeCount++;
      }
      globalContext.set(node.globalNodeCountVariable, nodeCount);

      node.globalVariable =
        "mqtt_client_" +
        node.datacake_configuration.workspace_id +
        "_" +
        node.connectionNumber;
      if (typeof globalContext.get(node.globalVariable) === "undefined") {
        var client = mqtt.connect("mqtts://mqtt.datacake.co", {
          port: 8883,
          username: node.datacake_configuration.api_token,
          password: node.datacake_configuration.api_token,
        });
        globalContext.set(node.globalVariable, client);
      } else {
        var client = globalContext.get(node.globalVariable);
      }

      var connectFunc = function () {
        var topic =
          "dtck/" +
          node.product_slug +
          "/" +
          node.device_id +
          "/" +
          node.field_id;

        client.subscribe(topic, function (err) {
          if (err) {
            node.log(
              "Datacake - Device Input: Verbindungs Fehler - Konfiguration überprüfen"
            );
            node.status({ fill: "red", shape: "ring", text: "disconnected" });
          } else {
            node.log("Datacake - Device Input: Verbindung erfolgreich.");
            node.log("Datacake - Device Input: Subscribe to " + topic);
            node.log(
              "Datacake - Device Input: " +
                nodeCount +
                " nodes running on this connection: " +
                node.globalVariable
            );
            node.log(
              "Datacake - Device Input: " +
                globalCount +
                " nodes connected overall"
            );
            node.status({ fill: "green", shape: "dot", text: "connected" });
          }
        });
      };

      client.on("connect", connectFunc);

      var messageFunc = function (topic, message) {
        node.send({
          payload: message.toString(),
          deviceId: node.device_id,
          fieldName: node.field_id,
        });
      };

      client.on("message", messageFunc);

      node.on("close", function () {
        var globalCount = globalContext.get(node.globalCountVariable);
        var nodeCount = globalContext.get(node.globalNodeCountVariable);
        node.log("Datacake - Device Input: Closing Node");
        nodeCount--;
        globalCount--;
        if (nodeCount < 1) {
          node.log(
            "Datacake - Device Input: MQTT connection closed, no remaining nodes"
          );
          client.removeEventListener(messageFunc);
          client.removeEventListener(connectFunc);
          client.end();
        } else {
          node.log(
            "Datacake - Device Input: Node closed, " +
              nodeCount +
              " remaining nodes"
          );
        }
        globalContext.set(node.globalNodeCountVariable, nodeCount);
        globalContext.set(node.globalCountVariable, globalCount);
      });
    }
  }

  RED.nodes.registerType("datacake-device-input", DatacakeDeviceInputNode);
};
