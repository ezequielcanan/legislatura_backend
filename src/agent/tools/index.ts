// src/agent/tools/index.ts
import { createSearchTool } from './search.tool';
import { createSentimentTool } from './sentiment.tool';

export const createAllTools = () => {
  return [
    createSearchTool(),
    createSentimentTool(),
  ];
};

export { createSearchTool, createSentimentTool };