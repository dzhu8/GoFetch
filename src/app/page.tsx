import ChatWindow from "@/components/ChatWindow";
import { Metadata } from "next";

export const metadata: Metadata = {
     title: "GoFetch Chat",
     description: "Chat with your file folders!",
};

const Home = () => {
     return <ChatWindow />;
};

export default Home;
