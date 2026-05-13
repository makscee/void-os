// Chat orchestrator. Routes messages to agents, manages sessions, streams events.

export interface ChatMessage {
  chatId: string;
  content: string;
}

export interface ChatOrchestrator {
  createChat(agent: string): Promise<{ id: string }>;
  postMessage(msg: ChatMessage): Promise<{ runId: string }>;
  listChats(): Promise<Array<{ id: string; agent: string; title: string; last: string }>>;
}

export const createChatOrchestrator = (): ChatOrchestrator => {
  throw new Error("not implemented");
};
