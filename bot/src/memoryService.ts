import { z } from 'zod';
import type { MemoryStore, MemoryContext } from './memory';
import type { LLMProvider } from './intent';

export interface MemoryService {
  extractAndStore(ctx: MemoryContext, message: string): Promise<void>;
  buildMemoryContextText(ctx: MemoryContext): Promise<string>;
}

// Ensure the LLM doesn't see owner_id in the output schema
const ExtractionSchema = z.object({
  type: z.enum(['fact', 'preference', 'ignore']),
  key: z.string().optional().describe('For facts, a stable key e.g., preferred_name, language, role, current_focus. For preferences, use scope.'),
  value: z.any().optional().describe('The value to store.'),
  scope: z.enum(['global', 'report']).optional().describe('Only used if type is preference. global or report.'),
  report_name: z.string().optional().describe('If scope is report, specify the report name.'),
});

// A credential-like regex based on standard patterns (very simple baseline)
const SECRET_REGEX = /(pass(word)?|passwd|secret|token|api[_-]?key|ssn|card[_-]?(no|number)|cvv|iban)/i;

export function createMemoryService(store: MemoryStore, llm?: LLMProvider): MemoryService {
  return {
    async extractAndStore(ctx: MemoryContext, message: string): Promise<void> {
      if (!llm) return;
      if (!message || message.trim().length === 0) return;

      // Rule 4: Refuse to store anything that looks like a credential
      if (SECRET_REGEX.test(message)) {
        console.warn(`Extraction rejected for potential secret matching: ${message}`);
        return;
      }

      try {
        const prompt = `You are a memory extraction assistant.
Extract any durable, explicit statements of fact or preference about the user from the following message.
DO NOT extract transient intents, one-off instructions, or guesses.

If it's a fact (e.g. name, language, role), use type "fact" and pick a stable "key".
If it's a preference (e.g. dark mode, preferred currency), use type "preference", and set "scope" to "global" or "report".
If there's nothing to store, use type "ignore".

Message: "${message}"

Respond with ONLY a JSON object matching this schema:
{"type": "fact"|"preference"|"ignore", "key": "string", "value": any, "scope": "global"|"report", "report_name": "string"}
`;
        
        const response = await llm.generateText(prompt);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        
        const parsed = JSON.parse(jsonMatch[0]);
        const result = ExtractionSchema.parse(parsed);

        if (result.type === 'fact' && result.key && result.value !== undefined) {
          // Allowed keys logic (Rule 3)
          const allowedKeys = ['preferred_name', 'language', 'role', 'current_focus'];
          if (allowedKeys.includes(result.key)) {
             await store.setFact(ctx, result.key, result.value, message);
          }
        } else if (result.type === 'preference' && result.scope && result.value !== undefined) {
          const scopeKey = result.scope === 'global' ? 'global' : `report:${result.report_name || 'default'}`;
          await store.setPreferences(ctx, scopeKey, result.value);
        }

      } catch (err: any) {
        // Rule 2: Failures are logged without message content and swallowed.
        console.warn('Memory extraction failed', err.message);
      }
    },

    async buildMemoryContextText(ctx: MemoryContext): Promise<string> {
      let memoryText = '';
      
      try {
        const facts = await store.listFacts(ctx);
        const prefGlobal = await store.getPreferences(ctx, 'global');
        
        if (facts.length > 0) {
          memoryText += 'Facts about the user:\n';
          for (const f of facts) {
             memoryText += `- ${f.key}: ${JSON.stringify(f.value)}\n`;
          }
        }

        if (Object.keys(prefGlobal).length > 0) {
          memoryText += '\nGlobal Preferences:\n';
          memoryText += JSON.stringify(prefGlobal, null, 2);
        }
      } catch (e) {
        // ignore read failures
      }

      // Rule 8: Cap total injected memory text (e.g. 500 tokens). Let's use characters (~1500 chars) for safety.
      if (memoryText.length > 1500) {
          memoryText = memoryText.substring(0, 1500) + '... (truncated)';
      }

      return memoryText.trim();
    }
  };
}