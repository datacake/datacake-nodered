module.exports = function(RED) {
    function DatacakeConfigurationNode(n) {
        RED.nodes.createNode(this, n);
        this.api_token = n.api_token;
        this.workspace_id = n.workspace_id;
    }
    RED.nodes.registerType("datacake-configuration", DatacakeConfigurationNode);
}