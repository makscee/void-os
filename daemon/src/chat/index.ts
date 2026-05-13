// Chat module barrel. ChatRepo lives in ./repo; the ChatOrchestrator
// interface moves to ./orchestrator in a later VOS-79 task.

export {
  makeChatRepo,
  type ChatRepo,
  type ChatRow,
  type ChatListItem,
} from "./repo";
