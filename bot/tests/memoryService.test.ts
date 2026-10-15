import { createMemoryService } from '../src/memoryService';

import type { MemoryContext, Fact } from '../src/memory';

describe('MemoryService', () => {
  let mockStore: any;
  let mockLlm: any;
  let service: any;
  const ctx: MemoryContext = { ownerId: 'owner1' };

  beforeEach(() => {
    mockStore = {
      setFact: jest.fn(),
      setPreferences: jest.fn(),
      listFacts: jest.fn().mockResolvedValue([]),
      getPreferences: jest.fn().mockResolvedValue({}),
    };
    
    mockLlm = {
      generateText: jest.fn(),
    };
    
    service = createMemoryService(mockStore, mockLlm);
  });

  it('extracts and stores a fact (name)', async () => {
    mockLlm.generateText.mockResolvedValue(`{"type": "fact", "key": "preferred_name", "value": "David"}`);
    
    await service.extractAndStore(ctx, "My name is David.");
    
    expect(mockLlm.generateText).toHaveBeenCalled();
    expect(mockStore.setFact).toHaveBeenCalledWith(ctx, "preferred_name", "David", "My name is David.");
  });

  it('rejects credential-like text without calling LLM', async () => {
    await service.extractAndStore(ctx, "My password is 1234");
    
    expect(mockLlm.generateText).not.toHaveBeenCalled();
    expect(mockStore.setFact).not.toHaveBeenCalled();
  });
  
  it('extracts and stores a global preference', async () => {
    mockLlm.generateText.mockResolvedValue(`{"type": "preference", "scope": "global", "value": {"theme": "dark"}}`);
    
    await service.extractAndStore(ctx, "I like dark mode.");
    
    expect(mockStore.setPreferences).toHaveBeenCalledWith(ctx, "global", { theme: "dark" });
  });

  it('ignores one-off instructions', async () => {
    mockLlm.generateText.mockResolvedValue(`{"type": "ignore"}`);
    
    await service.extractAndStore(ctx, "Show me the top users.");
    
    expect(mockStore.setFact).not.toHaveBeenCalled();
    expect(mockStore.setPreferences).not.toHaveBeenCalled();
  });

  it('handles LLM output with extraneous text gracefully if valid JSON exists', async () => {
    mockLlm.generateText.mockResolvedValue(`Sure, here is the JSON:\n{"type": "fact", "key": "preferred_name", "value": "Alice"}\nHope that helps!`);
    
    await service.extractAndStore(ctx, "Call me Alice.");
    
    expect(mockStore.setFact).toHaveBeenCalledWith(ctx, "preferred_name", "Alice", "Call me Alice.");
  });

  it('swallows extraction failures without throwing', async () => {
    mockLlm.generateText.mockRejectedValue(new Error('Network error'));
    
    await expect(service.extractAndStore(ctx, "I am testing.")).resolves.not.toThrow();
  });

  it('builds memory context correctly', async () => {
    const facts: Fact[] = [{ key: 'preferred_name', value: 'Alice', updated_at: new Date() }];
    mockStore.listFacts.mockResolvedValue(facts);
    mockStore.getPreferences.mockResolvedValue({ language: 'fr' });

    const text = await service.buildMemoryContextText(ctx);

    expect(text).toContain('preferred_name');
    expect(text).toContain('Alice');
    expect(text).toContain('language');
    expect(text).toContain('fr');
  });
  
  it('caps memory context to 1500 chars', async () => {
    const largeValue = "A".repeat(2000);
    const facts: Fact[] = [{ key: 'long_fact', value: largeValue, updated_at: new Date() }];
    mockStore.listFacts.mockResolvedValue(facts);
    
    const text = await service.buildMemoryContextText(ctx);
    
    expect(text.length).toBeLessThanOrEqual(1520); // 1500 + "... (truncated)" length
    expect(text).toContain('... (truncated)');
  });
});