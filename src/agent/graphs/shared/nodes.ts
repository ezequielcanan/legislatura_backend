// src/agent/graphs/shared/nodes.ts
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';

export const createLLM = (streaming: boolean = true) => {
  return new ChatOpenAI({
    model: process.env.OPENROUTER_DEFAULT_MODEL ?? 'x-ai/grok-4.1-fast',
    streaming,
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0.7,
    configuration: {
      baseURL: process.env.OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1',
    },
  });
};

export const createReasoningLLM = () => {
  return new ChatOpenAI({
    model: 'x-ai/grok-4.1-fast',
    streaming: true,
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0.3,
    configuration: {
      baseURL: process.env.OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1',
    },
  });
};

export const formatMessagesForLLM = (messages: Array<{ role: string; content: string }>) => {
  return messages.map(msg => {
    if (msg.role === 'system') return new SystemMessage(msg.content);
    if (msg.role === 'assistant' || msg.role === 'ai') return new AIMessage(msg.content);
    return new HumanMessage(msg.content);
  });
};

export const getCurrentTimestamp = () => {
  const now = new Date();
  const argTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return argTime.toISOString();
};