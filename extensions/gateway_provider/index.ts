import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";

const debug_mode = process.env.PI_EXTENSION_DEBUG_MODE === "true";
const debug_logger = (...args: any[]) =>
  debug_mode && console.log("[DEBUG]", ...args);

const extensionPath = `${process.env.HOME}/.pi/agent/extensions/gateway_provider`;
const customModelPath = `${extensionPath}/custom_models${debug_mode ? ".debug" : ""}.json`;

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsCachePath: string;
}

interface ModelInfo {
  modelCard: string;
  vendor: string;
  modelId: string;
}

function getProviderConfigs(): ProviderConfig[] {
  const namesValue = process.env.PROVIDER_NAMES;
  const baseUrlsValue = process.env.PROVIDER_BASE_URLS;
  const keysValue = process.env.PROVIDER_API_KEYS;
  const hasMultiProviderConfig = [namesValue, baseUrlsValue, keysValue].some(
    (value) => value !== undefined,
  );

  if (!hasMultiProviderConfig) {
    const baseUrl = process.env.PROVIDER_BASE_URL;
    const apiKey = process.env.PROVIDER_API_KEY;
    if (!baseUrl || !apiKey) {
      return [];
    }

    return [
      {
        name: "gateway",
        baseUrl,
        apiKey,
        modelsCachePath: `${extensionPath}/models.json`,
      },
    ];
  }

  if (!namesValue || !baseUrlsValue || !keysValue) {
    throw new Error(
      "PROVIDER_NAMES, PROVIDER_BASE_URLS, and PROVIDER_KEYS must all be set",
    );
  }

  const names = namesValue.split(",").map((value) => value.trim());
  const baseUrls = baseUrlsValue.split(",").map((value) => value.trim());
  const keys = keysValue.split(",").map((value) => value.trim());

  if (names.length !== baseUrls.length || names.length !== keys.length) {
    throw new Error(
      "PROVIDER_NAMES, PROVIDER_BASE_URLS, and PROVIDER_KEYS must contain the same number of values",
    );
  }
  if (
    names.some((value) => !value) ||
    baseUrls.some((value) => !value) ||
    keys.some((value) => !value)
  ) {
    throw new Error("Provider names, base URLs, and keys must not be empty");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("PROVIDER_NAMES must not contain duplicates");
  }

  return names.map((name, index) => ({
    name,
    baseUrl: baseUrls[index]!,
    apiKey: keys[index]!,
    modelsCachePath: `${extensionPath}/models.${encodeURIComponent(name)}.json`,
  }));
}

const builtins = builtinModels();
let customs: Record<string, any> = {};
if (fs.existsSync(customModelPath)) {
  customs = JSON.parse(fs.readFileSync(customModelPath, "utf8"));
}

function splitName(name: string) {
  if (name.includes("/")) {
    return name.split("/");
  }
  return name.split("@");
}

function processModelCard(modelCard: string) {
  // modelCard format:
  //   - from vendor: `vendor/modelId`
  //   - from third party gateway provider: `provider/vendor/modelId`

  let cardInfos = splitName(modelCard);

  let vendor = cardInfos.shift();
  if (!vendor) {
    throw new Error(`Invalid model card: ${modelCard}`);
  }

  let modelId;
  if (!builtins.getProvider(vendor)) {
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

async function fetchModels(provider: ProviderConfig) {
  const response = await fetch(provider.baseUrl + "/v1/models", {
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
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

  payload = payload.filter((model) => splitName(model.id).length >= 2);

  let modelInfos: ModelInfo[];
  modelInfos = payload.map((model) => {
    const [vendorName, modelName] = processModelCard(model.id);
    return { modelCard: model.id, vendor: vendorName, modelId: modelName };
  });

  const jsonString = JSON.stringify(modelInfos, null, 2);
  fs.writeFile(provider.modelsCachePath, jsonString, "utf8", (err) => {
    if (err) {
      throw new Error(`Error writing models cache file: ${err}`);
    }
  });

  return modelInfos;
}

function getProviderBaseUrl(api: string, providerBaseUrl: string): string {
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
      baseUrl = providerBaseUrl + "/gemini/v1beta";
      break;
    default:
      throw new Error(`Unsupported API: ${api}`);
  }
  return baseUrl;
}

function getBuiltinModel(
  modelInfo: ModelInfo,
  provider: ProviderConfig,
): Model<"openai-completions"> {
  const { modelCard, vendor, modelId } = modelInfo;

  debug_logger(`model card: ${modelCard}`);

  // if the model card is in the custom definition list, return the custom model definition
  const custom = customs[modelCard];
  if (custom) {
    debug_logger(`  - found custom model definition for ${modelCard}`);
    return {
      id: custom.id,
      name: custom.name,
      reasoning: custom.reasoning,
      input: custom.input,
      contextWindow: custom.contextWindow,
      maxTokens: custom.maxTokens,
      cost: custom.cost,
      compat: custom.compat,
      api: custom.api,
      provider: provider.name,
      baseUrl: getProviderBaseUrl(custom.api, provider.baseUrl),
    };
  }

  // default model definition if no builtin model found
  let model: Model<"openai-completions"> = {
    id: modelCard,
    name: modelCard,
    api: "openai-completions",
    provider: provider.name,
    baseUrl: provider.baseUrl + "/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  };

  debug_logger(
    `  - looking for builtin model definition: vendor=${vendor}, modelId=${modelId}`,
  );

  const builtin = builtins.getModel(vendor, modelId);
  if (builtin) {
    let api = builtin.api;
    let name = builtin.name;
    const providerName = splitName(modelCard)[0];
    if (vendor !== providerName) {
      // if the vendor is not the first part of the model card, it means the model is from a gateway provider
      api = "openai-completions";
      name = builtin.name + ` (provided by ${providerName})`;
    }

    let id = modelCard;
    let baseUrl = getProviderBaseUrl(api, provider.baseUrl);

    debug_logger(
      `  - builtin model found: ${builtin.id}, api=${builtin.api}, baseUrl=${builtin.baseUrl}`,
    );
    debug_logger(
      `  - override model info: ${id}, api=${api}, baseUrl=${baseUrl}`,
    );
    model = {
      ...builtin,
      id: id,
      name: name,
      api: api,
      provider: provider.name,
      baseUrl: baseUrl,
    };
  }

  return model;
}

function registerProvider(
  modelInfos: ModelInfo[],
  provider: ProviderConfig,
  pi: ExtensionAPI,
) {
  const builtinModelInfos = modelInfos.map((modelInfo) => {
    return getBuiltinModel(modelInfo, provider);
  });

  pi.registerProvider(provider.name, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: builtinModelInfos,
  });
}

async function loadModelInfos(provider: ProviderConfig): Promise<ModelInfo[]> {
  if (!fs.existsSync(provider.modelsCachePath)) {
    return fetchModels(provider);
  }

  if (
    Date.now() - fs.statSync(provider.modelsCachePath).mtimeMs >
      3 * 24 * 60 * 60 * 1000 ||
    debug_mode
  ) {
    return fetchModels(provider);
  }

  return JSON.parse(fs.readFileSync(provider.modelsCachePath, "utf8"));
}

export default async function (pi: ExtensionAPI) {
  const providers = getProviderConfigs();
  if (providers.length === 0) {
    return null;
  }

  for (const provider of providers) {
    const modelInfos = await loadModelInfos(provider);
    registerProvider(modelInfos, provider, pi);
  }

  pi.registerCommand("model-refresh", {
    description: "Refresh the list of models from the provider",
    handler: async (_, ctx) => {
      for (const provider of providers) {
        const modelInfos = await fetchModels(provider);
        registerProvider(modelInfos, provider, pi);
      }
      ctx.ui.notify("Models refreshed", "info");
    },
  });
}
