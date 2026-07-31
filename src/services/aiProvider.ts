/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Client-side AI Provider - Thin HTTP client that proxies all AI calls through the server.
 * NO API keys are stored or used on the client side.
 */

export interface AIProvider {
  name: string;
  supportsSearch: boolean;
  generateContent(params: ClientGenerateContentParams): Promise<ClientGenerateContentResponse>;
}

export interface ClientGenerateContentParams {
  contents: string;
  config?: {
    tools?: any[];
    responseMimeType?: string;
    responseSchema?: any;
    temperature?: number;
    maxOutputTokens?: number;
  };
}

export interface ClientGenerateContentResponse {
  text: string;
  candidates?: any[];
}

/**
 * Client-side AI service that proxies all requests to the server.
 * This ensures API keys never leave the server environment.
 */
class ClientAIService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = "/api/ai";
  }

  /**
   * Generate content via the server-side AI provider.
   * The server handles failover between multiple providers.
   */
  async generateContent(params: ClientGenerateContentParams): Promise<ClientGenerateContentResponse> {
    // For client-side calls, we now proxy through the server
    // This method is kept for compatibility but the actual implementation
    // uses specific endpoints for each operation type
    
    const response = await fetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Request failed" }));
      throw new Error(error.error || "AI generation failed");
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error || "AI generation failed");
    }

    return { text: data.response || "", candidates: [] };
  }

  /**
   * Get the name of the currently active provider (for diagnostics display)
   */
  getActiveProviderName(): string {
    return "Server-Proxy";
  }

  /**
   * Reset is now a no-op on the client (server handles state)
   */
  reset(): void {
    // Server handles provider state
  }

  /**
   * Test all providers via the server
   */
  async testAllProviders(): Promise<{ name: string; status: 'ok' | 'error' | 'no-key'; error?: string }[]> {
    try {
      const response = await fetch(`${this.baseUrl}/diagnostics`);
      if (!response.ok) throw new Error("Diagnostics failed");
      const data = await response.json();
      return data.providers || [];
    } catch (error: any) {
      return [{ name: "Server", status: 'error', error: error.message }];
    }
  }

  /**
   * Generate news articles via server
   */
  async generateNews(category: string, region: string, today: string, existingIds: string[] =[]): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/news/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, region, today, existingIds }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to generate news" }));
      throw new Error(error.error || "Failed to generate news");
    }

    const data = await response.json();
    return data.articles || [];
  }

  /**
   * Search news via server
   */
  async searchNews(query: string): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Search failed" }));
      throw new Error(error.error || "Search failed");
    }

    const data = await response.json();
    return data.articles || [];
  }

  /**
   * Generate article synthesis via server
   */
  async generateSynthesis(title: string, summary: string, source: string, url: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/synthesis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, summary, source, url }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Synthesis failed" }));
      throw new Error(error.error || "Synthesis failed");
    }

    const data = await response.json();
    return data.synthesis;
  }

  /**
   * Generate article extras (quiz, flashcards, scripts) via server
   */
  async generateExtras(title: string, summary: string, source: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/extras`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, summary, source }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Extras generation failed" }));
      throw new Error(error.error || "Extras generation failed");
    }

    const data = await response.json();
    return data.extras;
  }

  /**
   * Chat with AI via server
   */
  async chat(articleTitle: string, context: string, message: string, history: { role: 'user' | 'model', text: string }[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleTitle, context, message, history }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ response: "Chat failed" }));
      throw new Error(error.response || "Chat failed");
    }

    const data = await response.json();
    return data.response || "I'm sorry, I couldn't process that request at the moment.";
  }
}

export const unifiedAI = new ClientAIService();
