import { NodeProperties, Red } from "node-red";
import { Node } from "node-red-contrib-typescript-node";
import { MqttClient } from "mqtt";

module.exports = (RED: Red) => {
  class DatacakeIn extends Node {
    private topic: string;

    constructor(
      config: NodeProperties & {
        datacakeConfiguration: string;
        productSlug: string;
        deviceId: string;
        fieldName: string;
      }
    ) {
      super(RED);

      this.createNode(config);

      const configuration = RED.nodes.getNode(
        config.datacakeConfiguration
      ) as Node & { client: MqttClient; matchTopic: (t, ts) => boolean };
      if (!configuration) {
        this.status({
          fill: "red",
          shape: "ring",
          text: "Broker not connected",
        });
      }

      this.topic = `dtck/${config.productSlug}/${config.deviceId}/${config.fieldName}`;

      configuration.client.subscribe(this.topic, (err) => {
        if (err) {
          this.status({ fill: "red", shape: "ring", text: "disconnected" });
        } else {
          this.status({ fill: "green", shape: "dot", text: "connected" });
        }
      });
      configuration.client.on("close", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("disconnect", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("offline", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("error", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("message", (topic, message) => {
        if (configuration.matchTopic(this.topic, topic)) {
          const [_, productSlug, deviceId, fieldName] = topic.split("/");
          this.send({
            payload: message.toString(),
            deviceId,
            fieldName,
            productSlug,
          });
        }
      });

      this.on("input", (msg: any) => {
        msg.payload = "asdf";
        this.send(msg);
      });
    }
  }

  DatacakeIn.registerType(RED, "datacake-in");

  class DatacakeOut extends Node {
    constructor(
      config: NodeProperties & {
        datacakeConfiguration: string;
        productSlug: string;
        deviceId: string;
        fieldName: string;
      }
    ) {
      super(RED);

      this.createNode(config);

      const configuration = RED.nodes.getNode(
        config.datacakeConfiguration
      ) as Node & { client: MqttClient };
      if (!configuration) {
        this.status({
          fill: "red",
          shape: "ring",
          text: "Broker not connected",
        });
      }

      configuration.client.on("connect", () => {
        this.status({ fill: "green", shape: "dot", text: "connected" });
      });
      configuration.client.on("close", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("disconnect", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("offline", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });
      configuration.client.on("error", () => {
        this.status({ fill: "red", shape: "ring", text: "disconnected" });
      });

      this.on("input", (msg: any) => {
        const topic = `dtck-pub/${msg.productSlug ||
          config.productSlug}/${msg.deviceId ||
          config.deviceId}/${msg.fieldName || config.fieldName}`;
        configuration.client.publish(topic, msg.payload.toString());
      });
    }
  }

  DatacakeOut.registerType(RED, "datacake-out");
};
