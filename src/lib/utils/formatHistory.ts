import { BaseMessage, AIMessage } from "@langchain/core/messages";

const formatChatHistoryAsString = (history: BaseMessage[]) => {
     return history.map((message) => `${AIMessage.isInstance(message) ? "AI" : "User"}: ${message.content}`).join("\n");
};

export default formatChatHistoryAsString;
