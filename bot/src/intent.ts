import { z } from 'zod';

export type Intent = 'database_question' | 'memory_write' | 'memory_read' | 'chitchat';

export interface LLMProvider {
  generateText(prompt: string): Promise<string>;
}

export class IntentClassifier {
  private schema = z.object({
    intent: z.enum(['database_question', 'memory_write', 'memory_read', 'chitchat']),
  });

  constructor(private llm?: LLMProvider) {}

  async classify(text: string): Promise<Intent> {
    const trimmed = text.trim();
    if (!trimmed) return 'database_question';

    const lower = trimmed.toLowerCase();

    // Cheap deterministic rules first
    if (/^(my name is|remember that|i like|i prefer|i want|call me) /i.test(lower)) {
      return 'memory_write';
    }
    if (/^(what is my name|what's my name|what did we discuss|what were we talking about|do you remember|who am i)[\?]*$/i.test(lower)) {
      return 'memory_read';
    }
    if (/^(hi|hello|hey|thanks|thank you|bye|goodbye|morning|afternoon|evening)$/i.test(lower)) {
      return 'chitchat';
    }
    
    // Fast path out for clear db queries
    if (/^(show|list|count|how many|what is the total|sum|average|give me|find)/i.test(lower)) {
      return 'database_question';
    }

    if (!this.llm) {
        return 'database_question';
    }

    // Small LLM call for ambiguous messages
    try {
      const prompt = `Classify the following user message into one of these exact intents:
- "database_question": Asking for data, numbers, reports, querying a database.
- "memory_write": The user is telling you a fact about themselves to remember, like their name or a preference.
- "memory_read": The user is asking you to recall a fact about themselves or a previous conversation.
- "chitchat": General conversation, greetings, pleasantries.

Message: "${text}"

Respond with ONLY a valid JSON object matching this schema: {"intent": "database_question" | "memory_write" | "memory_read" | "chitchat"}
Do not include markdown blocks or any other text.`;
      
      const response = await this.llm.generateText(prompt);
      
      // Try to parse JSON from the response. Sometimes LLMs return markdown blocks.
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : response;

      const parsed = JSON.parse(jsonStr);
      const validated = this.schema.parse(parsed);
      return validated.intent;
    } catch (e) {
      // Fail toward database_question on any classifier error
      return 'database_question';
    }
  }

  async generateChitchatReply(text: string): Promise<string> {
      if (!this.llm) {
          return "Hello! I am your database assistant. How can I help you today?";
      }
      try {
          const prompt = `You are a helpful database assistant. The user sent a chitchat message. 
Reply briefly and politely (1-2 sentences), and gently guide them to ask a database question.

User message: "${text}"

Reply:`;
          return await this.llm.generateText(prompt);
      } catch (e) {
          return "Hello! I am your database assistant. How can I help you today?";
      }
  }
}
