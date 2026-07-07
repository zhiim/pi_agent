import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/../providers/all";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";

const debug_mode = process.env.PI_EXTENSION_DEBUG_MODE === "true";
const debug_logger = (...args: any[]) =>
  debug_mode && console.log("[DEBUG]", ...args);

const providerBaseUrl = process.env.PROVIDER_BASE_URL!;
const providerApiKey = process.env.PROVIDER_API_KEY;
const modelsCachePath = `${process.env.HOME}/.pi/agent/extensions/gateway_provider/models.json`;

const models = builtinModels();

function processModelCard(modelCard: string) {
  // modelCard format:
  //   - from vendor: `vendor/modelId`
  //   - from third party gateway provider: `provider/vendor/modelId`

  let cardInfos = modelCard.split("/");

  let vendor = cardInfos.shift();
  if (!vendor) {
    throw new Error(`Invalid model card: ${modelCard}`);
  }

  let modelId;
  if (!models.getProvider(vendor)) {
    // if no builtin provider found, model card is from third party gateway provider or not suported vendor
    modelId = cardInfos.pop();
    if (!modelId) {
      throw new Error(`Invalid model card: ${modelCard}`);
    }
    vendor = cardInfos.pop() ?? vendor;
  } else {
    // if builtin provider found, model card is from suported vendor
    modelId = cardInfos.join("/");
  }

  return [vendor, modelId];
}

async function fetchModels() {
  const response = await fetch(providerBaseUrl + "/v1/models", {
    headers: {
      Authorization: `Bearer ${providerApiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  let payload = (await response.json()).data as Array<{
    id: string;
  }>;
  if (debug_mode) {
    payload = JSON.parse(
      fs.readFileSync(
        `${process.env.HOME}/.pi/agent/extensions/gateway_provider/models.debug.json`,
        "utf8",
      ),
    ).data;
  }

  payload = payload.filter((model) => model.id.split("/").length >= 2);

  let modelInfos: Array<{
    modelCard: string;
    vendor: string;
    modelId: string;
  }>;
  modelInfos = payload.map((model) => {
    const [vendorName, modelName] = processModelCard(model.id);
    return { modelCard: model.id, vendor: vendorName, modelId: modelName };
  });

  const jsonString = JSON.stringify(modelInfos, null, 2);
  fs.writeFile(modelsCachePath, jsonString, "utf8", (err) => {
    if (err) {
      throw new Error(`Error writing models cache file: ${err}`);
    }
  });

  return modelInfos;
}

function getBuiltinModel(modelInfo: {
  modelCard: string;
  vendor: string;
  modelId: string;
}): Model<"openai-completions"> {
  const { modelCard, vendor, modelId } = modelInfo;

  debug_logger(`model card: ${modelCard}`);

  // default model definition if no builtin model found
  let model: Model<"openai-completions"> = {
    id: modelCard,
    name: modelCard,
    api: "openai-completions",
    provider: "gateway",
    baseUrl: providerBaseUrl + "/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  };

  debug_logger(
    `  - looking for builtin model: vendor=${vendor}, modelId=${modelId}`,
  );
  const builtin = models.getModel(vendor, modelId);
  if (builtin) {
    let api = builtin.api;
    if (vendor !== modelCard.split("/")[0]) {
      // if the vendor is not the first part of the model card, it means the model is from a gateway provider
      api = "openai-completions";
    }

    let id = modelCard;
    let baseUrl;
    switch (api) {
      case "openai-completions":
        baseUrl = providerBaseUrl + "/v1";
        break;
      case "openai-responses":
        baseUrl = providerBaseUrl + "/v1";
        break;
      case "anthropic-messages":
        baseUrl = providerBaseUrl + "/anthropic";
        break;
      case "google-generative-ai":
        // model id of gemini API should not contain `/`
        id = modelId;
        baseUrl = providerBaseUrl + "/gemini/v1beta";
        break;
      default:
        throw new Error(`Unsupported API: ${builtin.api}`);
    }

    debug_logger(
      `  - builtin model found: ${builtin.id}, api=${builtin.api}, baseUrl=${builtin.baseUrl}`,
    );
    debug_logger(
      `  - override model info: ${id}, api=${api}, baseUrl=${baseUrl}`,
    );
    model = {
      ...builtin,
      id: id,
      api: api,
      provider: "gateway",
      baseUrl: baseUrl,
    };
  }

  return model;
}

export default async function (pi: ExtensionAPI) {
  if (!providerBaseUrl || !providerApiKey) {
    return null;
  }

  function registerProvider(
    modelInfos: Array<{
      modelCard: string;
      vendor: string;
      modelId: string;
    }>,
  ) {
    const builtinModelInfos = modelInfos.map((modelInfo) => {
      return getBuiltinModel(modelInfo);
    });

    pi.registerProvider("gateway", {
      baseUrl: providerBaseUrl,
      apiKey: providerApiKey,
      models: builtinModelInfos,
    });
  }

  let modelInfos;
  if (!fs.existsSync(modelsCachePath)) {
    modelInfos = fetchModels();
  } else {
    if (
      Date.now() - fs.statSync(modelsCachePath).mtimeMs >
        3 * 24 * 60 * 60 * 1000 ||
      debug_mode
    ) {
      modelInfos = fetchModels();
    } else {
      modelInfos = JSON.parse(fs.readFileSync(modelsCachePath, "utf8"));
    }
  }

  modelInfos = await modelInfos;

  registerProvider(modelInfos);

  pi.registerCommand("model_refresh", {
    description: "Refresh the list of models from the provider",
    handler: async (_, ctx) => {
      let modelInfos = await fetchModels();
      registerProvider(modelInfos);
      ctx.ui.notify("Models refreshed", "info");
    },
  });
}
