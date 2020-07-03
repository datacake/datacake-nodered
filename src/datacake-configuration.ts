import { NodeProperties, Red } from "node-red";
import { Node } from "node-red-contrib-typescript-node";
import mqtt, { MqttClient } from "mqtt";

module.exports = (RED: Red) => {
  class DatacakeConfiguration extends Node {
    public client: MqttClient;

    constructor(config: NodeProperties & { apiKey: string }) {
      super(RED);

      const clientId =
        "cakered_mqtt_" + (1 + Math.random() * 4294967295).toString(16);

      const { apiKey } = config;
      if (!!apiKey) {
        this.client = mqtt.connect("mqtts://mqtt.datacake.co", {
          port: 8883,
          username: apiKey,
          password: apiKey,
          clientId,
        });
        this.client.on("connect", () => {
          console.log("Connected to Datacake MQTT Broker");
        });
      }

      this.createNode(config);
    }

    public matchTopic(ts: string, t: string): boolean {
      const re = new RegExp(
        "^" +
          ts
            .replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g, "\\$1")
            .replace(/\+/g, "[^/]+")
            .replace(/\/#$/, "(/.*)?") +
          "$"
      );
      return re.test(t);
    }
  }

  DatacakeConfiguration.registerType(RED, "datacake-configuration", {
    credentials: {
      apiKey: { type: "password" },
    },
  });
};
