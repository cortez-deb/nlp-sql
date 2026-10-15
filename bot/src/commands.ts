import type { NLSQLClient } from 'nlsql';
import type { ChatState } from './state';
import type { GatewayAdapter } from './gateway';
import type { MemoryStore } from './memory';

export interface CommandContext {
  chatId: string;
  ownerId: string;
  commandText: string;
  state: ChatState;
  client: NLSQLClient;
  gateway: GatewayAdapter;
  memoryStore?: MemoryStore;
  onExportLast: () => Promise<void>;
}

let isRefreshing = false;

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { chatId, ownerId, state, commandText, client, gateway, memoryStore, onExportLast } = ctx;
  const trimmed = commandText.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').toLowerCase();

  switch (cmd) {
    case '/help': {
      const helpText = [
        '*Database Assistant Help*',
        '',
        'Ask me questions about your database in plain English!',
        '',
        '*Examples:*',
        '• "How many orders were placed last month?"',
        '• "Who are our top 5 customers by revenue?"',
        '',
        '*Commands:*',
        '• */help* - Show this help guide',
        '• */tables* - List available database tables',
        '• */sql* - Show SQL query for the last answer',
        '• */csv* - Export last query results as CSV',
        '• */memory* - Show stored facts and preferences',
        '• */forget* - Delete all stored facts and preferences',
        '• */reset* - Clear conversation history',
        '• */refresh* [all] - Refresh schema enrichment',
      ].join('\n');
      await gateway.sendText(chatId, helpText);
      return;
    }

    case '/tables': {
      try {
        const schema = await client.getEnrichedSchema();
        if (!schema || schema.length === 0) {
          await gateway.sendText(chatId, 'No enriched tables found.');
          return;
        }

        const lines = schema.map((t) => {
          const bName = t.businessName?.trim();
          return bName ? `${bName} (${t.tableName})` : t.tableName;
        });

        const maxLines = 40;
        let responseText = '*Available Tables:*\n';
        if (lines.length <= maxLines) {
          responseText += lines.map((l) => `• ${l}`).join('\n');
        } else {
          const shown = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          responseText += shown.map((l) => `• ${l}`).join('\n');
          responseText += `\n... and ${remaining} more tables.`;
        }

        await gateway.sendText(chatId, responseText);
      } catch (err: any) {
        await gateway.sendText(
          chatId,
          'Failed to retrieve tables: ' + (err instanceof Error ? err.message : String(err))
        );
      }
      return;
    }

    case '/sql': {
      if (state.lastQuery && state.lastQuery.sql) {
        await gateway.sendText(chatId, '```\n' + state.lastQuery.sql + '\n```');
      } else {
        await gateway.sendText(chatId, 'No query yet.');
      }
      return;
    }

    case '/csv': {
      await onExportLast();
      return;
    }

    case '/memory': {
      if (!memoryStore) {
        await gateway.sendText(chatId, 'Memory is disabled.');
        return;
      }
      try {
        const memCtx = { ownerId };
        const facts = await memoryStore.listFacts(memCtx);
        if (facts.length === 0) {
          await gateway.sendText(chatId, 'I have no facts stored about you.');
          return;
        }
        const text = '*Stored Facts*\n' + facts.map(f => `• ${f.key}: ${JSON.stringify(f.value)}`).join('\n');
        await gateway.sendText(chatId, text);
      } catch (err: any) {
        await gateway.sendText(chatId, 'Failed to read memory.');
      }
      return;
    }

    case '/forget': {
      if (!memoryStore) {
        await gateway.sendText(chatId, 'Memory is disabled.');
        return;
      }
      
      if (arg !== 'confirm') {
        await gateway.sendText(chatId, 'Are you sure you want me to forget everything? Reply */forget confirm* to proceed.');
        return;
      }
      
      try {
        await memoryStore.deleteAllForOwner({ ownerId });
        await gateway.sendText(chatId, 'I have forgotten all stored facts, preferences and history.');
      } catch (err: any) {
        await gateway.sendText(chatId, 'Failed to clear memory.');
      }
      return;
    }

    case '/reset': {
      state.turns = [];
      state.lastQuery = null;
      await gateway.sendText(chatId, 'Conversation context reset.');
      return;
    }

    case '/refresh': {
      if (isRefreshing) {
        await gateway.sendText(chatId, 'A refresh is already running.');
        return;
      }

      isRefreshing = true;
      const forceRefresh = arg === 'all';
      try {
        await gateway.sendText(
          chatId,
          'Refreshing schema, this can take a few minutes...'
        );

        const summary = await client.enrich({ forceRefresh });
        const summaryText = summary
          ? `Schema refresh complete: ${summary.enriched} enriched, ${summary.skipped} skipped, ${summary.failed.length} failed.`
          : 'Schema refresh complete.';
        await gateway.sendText(chatId, summaryText);
      } catch (err: any) {
        await gateway.sendText(
          chatId,
          'Schema refresh failed: ' + (err instanceof Error ? err.message : String(err))
        );
      } finally {
        isRefreshing = false;
      }
      return;
    }

    default: {
      await gateway.sendText(chatId, 'Unknown command. Send /help.');
      return;
    }
  }
}
