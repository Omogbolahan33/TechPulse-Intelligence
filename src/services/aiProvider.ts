import { ai, MODELS } from "../lib/gemini";
import { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import OpenAI from "openai";
import Groq from "groq-sdk";
import Anthropic from "@anthropic-ai/sdk";

export interface AIProvider {
  name: string;
  supportsSearch: boolean;
  generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse>;
}

// ------------------------------------------------------------------
// 1. NATIVE GEMINI PROVIDERS
// ------------------------------------------------------------------

class GeminiFlashProvider implements AIProvider {
  name = "Gemini 3 Flash";
  supportsSearch = true;
  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    return await ai.models.generateContent({
      ...params,
      model: MODELS.FLASH
    });
  }
}

class GeminiLiteProvider implements AIProvider {
  name = "Gemini 3.1 Flash Lite";
  supportsSearch = true;
  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    return await ai.models.generateContent({
      ...params,
      model: MODELS.LITE
    });
  }
}

class GeminiProProvider implements AIProvider {
  name = "Gemini 3.1 Pro";
  supportsSearch = true;
  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    return await ai.models.generateContent({
      ...params,
      model: MODELS.PRO
    });
  }
}

// ------------------------------------------------------------------
// 2. BYOK ENTERPRISE MATRIX PROVIDERS
// ------------------------------------------------------------------

class OpenAIProvider implements AIProvider {
  name = "OpenAI (GPT-4o)";
  supportsSearch = false;
  private client: OpenAI | null = null;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (key) {
      this.client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
    }
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    if (!this.client) throw new Error("OpenAI API Key not configured.");
    
    const prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
    const requiresJson = params.config?.responseMimeType === "application/json";

    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: requiresJson ? { type: "json_object" } : undefined,
      temperature: params.config?.temperature || 0.7,
    });

    const content = response.choices[0]?.message?.content || "";
    return { text: content } as GenerateContentResponse;
  }
}

class GroqProvider implements AIProvider {
  name = "Groq (Llama-3)";
  supportsSearch = false;
  private client: Groq | null = null;

  constructor() {
    const key = process.env.GROQ_API_KEY;
    if (key) {
      this.client = new Groq({ apiKey: key, dangerouslyAllowBrowser: true });
    }
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    if (!this.client) throw new Error("Groq API Key not configured.");
    
    let prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
    const requiresJson = params.config?.responseMimeType === "application/json";

    if (requiresJson && !prompt.toLowerCase().includes("json")) {
       prompt += "\n\nRETURN ONLY VALID JSON.";
    }

    const response = await this.client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: requiresJson ? { type: "json_object" } : undefined,
      temperature: params.config?.temperature || 0.7,
    });

    const content = response.choices[0]?.message?.content || "";
    return { text: content } as GenerateContentResponse;
  }
}

class AnthropicProvider implements AIProvider {
  name = "Anthropic (Claude 3.5)";
  supportsSearch = false;
  private client: Anthropic | null = null;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) {
      this.client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    }
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    if (!this.client) throw new Error("Anthropic API Key not configured.");
    
    const prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
    const requiresJson = params.config?.responseMimeType === "application/json";
    const systemPrompt = requiresJson ? "You are a data synthesis engine. You must output ONLY valid JSON that satisfies the user prompt requirements. Do not include markdown codeblocks or conversational text outside the JSON." : "";

    const response = await this.client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      temperature: params.config?.temperature || 0.7,
    });

    const content = 'text' in response.content[0] ? response.content[0].text : "";
    return { text: content } as GenerateContentResponse;
  }
}

class OpenRouterProvider implements AIProvider {
  name = "OpenRouter (Universal Aggregator)";
  supportsSearch = false; // Standard auto-router doesn't guarantee search grounding
  private client: OpenAI | null = null;

  constructor() {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) {
      // OpenRouter uses the exact same SDK footprint as OpenAI
      this.client = new OpenAI({ 
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key, 
        dangerouslyAllowBrowser: true 
      });
    }
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    if (!this.client) throw new Error("OpenRouter API Key not configured.");
    
    let prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
    const requiresJson = params.config?.responseMimeType === "application/json";

    if (requiresJson && !prompt.toLowerCase().includes("json")) {
       prompt += "\n\nRETURN ONLY VALID JSON.";
    }

    const response = await this.client.chat.completions.create({
      // We route to an auto-router, or specifically to a Xiaomi model if available.
      // Auto-router finds the best/cheapest model for the task.
      model: "openrouter/auto",
      messages: [{ role: "user", content: prompt }],
      // response_format support varies by model on OpenRouter, so we enforce it via prompt above for safety
      temperature: params.config?.temperature || 0.7,
      max_tokens: 4000, // Prevention against "too many tokens requested" errors
    });

    const content = response.choices[0]?.message?.content || "";
    return { text: content } as GenerateContentResponse;
  }
}

/**
 * OpenRouter specialized online model for search tasks (e.g. Perplexity)
 */
class OpenRouterOnlineProvider implements AIProvider {
  name = "OpenRouter Online (Perplexity/Search)";
  supportsSearch = true;
  private client: OpenAI | null = null;

  constructor() {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) {
      this.client = new OpenAI({ 
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key, 
        dangerouslyAllowBrowser: true 
      });
    }
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    if (!this.client) throw new Error("OpenRouter API Key not configured.");
    
    let prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
    const requiresJson = params.config?.responseMimeType === "application/json";

    if (requiresJson && !prompt.toLowerCase().includes("json")) {
       prompt += "\n\nRETURN ONLY VALID JSON.";
    }

    const response = await this.client.chat.completions.create({
      // Using Perplexity Sonar which is the current stable name for search grounding
      model: "perplexity/sonar",
      messages: [{ role: "user", content: prompt }],
      temperature: params.config?.temperature || 0.1, // Low temp for search accuracy
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message?.content || "";
    return { text: content } as GenerateContentResponse;
  }
}

class FailoverAIService {
  private providers: AIProvider[];
  private currentProviderIndex: number = 0;
  private blacklistedProviders: Map<string, number> = new Map(); // providerName -> expiryTimestamp

  constructor() {
    // Dynamically build the active fleet based on available keys
    const fleet: AIProvider[] = [
      new GeminiFlashProvider(),
      new GeminiLiteProvider(),
    ];

    if (process.env.GROQ_API_KEY) fleet.push(new GroqProvider());
    if (process.env.OPENAI_API_KEY) fleet.push(new OpenAIProvider());
    if (process.env.ANTHROPIC_API_KEY) fleet.push(new AnthropicProvider());
    
    if (process.env.OPENROUTER_API_KEY) {
      // Add the searching specialist if OpenRouter is enabled
      fleet.push(new OpenRouterOnlineProvider());
      fleet.push(new OpenRouterProvider());
    }

    // Pro sits at the absolute bottom as the heavy fallback net
    fleet.push(new GeminiProProvider());
    
    this.providers = fleet;
  }

  private isBlacklisted(providerName: string): boolean {
    const now = Date.now();
    const expiry = this.blacklistedProviders.get(providerName);
    if (expiry && now < expiry) {
      return true;
    }
    if (expiry && now >= expiry) {
      this.blacklistedProviders.delete(providerName);
    }
    return false;
  }

  private blacklistProvider(providerName: string, isAuthError: boolean = false) {
    const nowDate = new Date();
    const nowMs = nowDate.getTime();
    let expiry = 0;

    if (isAuthError) {
      // Auth errors (invalid keys) are blacklisted until midnight
      const tomorrow = new Date(nowDate);
      tomorrow.setDate(nowDate.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      expiry = tomorrow.getTime();
      console.warn(`[AI MATRIX] Hard blacklisting ${providerName} until midnight due to auth/config failure.`);
    } else {
      // Quota/Rate limits are transient. Blacklist for only 5 minutes.
      expiry = nowMs + 5 * 60 * 1000;
      console.warn(`[AI MATRIX] Soft blacklisting ${providerName} for 5 minutes due to quota/rate limit.`);
    }
    
    this.blacklistedProviders.set(providerName, expiry);
  }

  async generateContent(params: Omit<GenerateContentParameters, 'model'> & { model?: string }): Promise<GenerateContentResponse> {
    let lastError: any;
    let useSearch = !!(params as any).config?.tools?.some((t: any) => 'googleSearch' in t);
    
    // Try starting from the current "healthy" provider
    for (let i = 0; i < this.providers.length; i++) {
      const index = (this.currentProviderIndex + i) % this.providers.length;
      const provider = this.providers[index];
      
      if (this.isBlacklisted(provider.name)) {
        continue;
      }

      // HALLUCINATION BLOCKER: If search is required, SKIP non-search providers.
      if (useSearch && !provider.supportsSearch) {
        continue; 
      }
      
      try {
        console.log(`Attempting generation with: ${provider.name} (Search: ${useSearch})`);
        
        const isGemini = provider.name.includes('Gemini');
        let adaptedParams = params;
        
        if (!isGemini && useSearch) {
           adaptedParams = {
            ...params,
            config: {
              ...(params as any).config,
              tools: undefined
            }
          };
        }

        const response = await provider.generateContent(adaptedParams);
        
        this.currentProviderIndex = index;
        return response;
      } catch (error: any) {
        const errorMsg = (error?.message || String(error)).toLowerCase();
        const errorDetails = JSON.stringify(error).toLowerCase();
        
        const isSearchQuota = errorMsg.includes("search_grounding") || 
                             errorDetails.includes("search_grounding");
        const isGeneralQuota = errorMsg.includes("quota exceeded") || 
                              errorMsg.includes("429") ||
                              errorMsg.includes("rate limit") ||
                              errorMsg.includes("402") || 
                              errorMsg.includes("credits") ||
                              errorMsg.includes("billing") ||
                              errorMsg.includes("payment required") ||
                              errorMsg.includes("limit reached") ||
                              errorDetails.includes("resource_exhausted") ||
                              errorDetails.includes("insufficient_quota");
        const isAuthError = errorMsg.includes("api key not valid") || 
                           errorMsg.includes("401") ||
                           errorMsg.includes("unauthorized") ||
                           errorMsg.includes("invalid_argument") && errorMsg.includes("api key") ||
                           errorMsg.includes("key_invalid");
        const isTransientError = errorMsg.includes("rpc failed") ||
                                errorMsg.includes("internal error") ||
                                errorMsg.includes("500") ||
                                errorMsg.includes("503") ||
                                errorMsg.includes("unavailable") ||
                                errorMsg.includes("deadline exceeded") ||
                                errorMsg.includes("xhr error");

        // Blacklist logic
        if (isAuthError) {
          this.blacklistProvider(provider.name, true);
        } else if (isGeneralQuota) {
          this.blacklistProvider(provider.name, false);
        } else if (isTransientError) {
           console.warn(`[AI MATRIX] Transient failure on ${provider.name}. Attempting next node...`);
           // No long-term blacklist, just move to next
        }

        if (isSearchQuota && useSearch && provider.name.includes('Gemini')) {
          console.warn(`Search grounding quota hit for ${provider.name}. Retrying without search...`);
          
          const paramsWithoutSearch = {
            ...params,
            config: {
              ...(params as any).config,
              tools: (params as any).config?.tools?.filter((t: any) => !('googleSearch' in t))
            }
          };
          if (paramsWithoutSearch.config.tools?.length === 0) delete (paramsWithoutSearch as any).config.tools;
          
          try {
            const fallbackResponse = await provider.generateContent(paramsWithoutSearch as any);
            this.currentProviderIndex = index;
            return fallbackResponse;
          } catch (fallbackError: any) {
            const fallbackErrorMsg = (fallbackError?.message || String(fallbackError)).toLowerCase();
            if (fallbackErrorMsg.includes("quota exceeded") || fallbackErrorMsg.includes("rate limit")) {
              this.blacklistProvider(provider.name);
            }
            lastError = fallbackError;
          }
        } else {
          console.error(`Provider ${provider.name} failed:`, errorMsg);
          lastError = error;
        }
      }
    }

    throw lastError || new Error(`No search-capable intelligence nodes are currently online. Real-time grounding is unavailable.`);
  }

  // Method to manually switch or reset
  reset() {
    this.currentProviderIndex = 0;
  }

  getActiveProviderName(): string {
    return this.providers[this.currentProviderIndex].name;
  }

  // Diagnostic Test Method
  async testAllProviders(): Promise<{ name: string; status: 'ok' | 'error' | 'no-key'; error?: string }[]> {
    const results: { name: string; status: 'ok' | 'error' | 'no-key'; error?: string }[] = [];
    
    for (const provider of this.providers) {
      try {
        // Simple ping
        await provider.generateContent({
          contents: "ping",
          config: { temperature: 0.1, maxOutputTokens: 5 }
        } as any);
        results.push({ name: provider.name, status: 'ok' });
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes("not configured") || msg.includes("Key not configured")) {
          results.push({ name: provider.name, status: 'no-key' });
        } else {
          results.push({ name: provider.name, status: 'error', error: msg });
        }
      }
    }
    return results;
  }
}

export const unifiedAI = new FailoverAIService();
