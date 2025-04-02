import dotenv from 'dotenv';
dotenv.config();
import { app, BrowserWindow, ipcMain } from 'electron';
import { fetchEmails, classifyMessage, summarizeMessage, markAsRead } from './tools.js';
import { DynamicStructuredTool  } from "langchain/tools"
import { z } from "zod";

const storedEmails = new Map(); // key: UID, value: email object
const chatHistory = []

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true, // For quick development; consider using preload for production
      contextIsolation: false,
      // preload: path.join(__dirname, 'preload.js'), // Uncomment if using a preload script
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  createWindow();

  // Initial fetch + show emails
  const raw = await fetchEmails();
  
  if (raw && Array.isArray(raw.emails)) {
    const emails = raw.emails;

    emails.forEach(email => {
      storedEmails.set(email.uid, {
        uid: email.uid,
        subject: email.subject || "(No subject)",
        sender: email.sender || "Unknown",
        body: email.body || "",
        isRead: false,
        isProcessed: false,
        summary: null,
        classification: {
          priority: "unknown",
          category: "uncategorized",
        },
        status: "fetched",
      });

      showUser(storedEmails.get(email.uid));
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit the app when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
    app.quit();
    }
});

function showUser(data) {
    console.log("Sending data to renderer.");
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('showUser', data);
    });
}

const fetchEmailsTool = new DynamicStructuredTool({
  name: "fetchEmails",
  description: "Fetch new emails and store them in memory.",
  schema: z.object({}),
  func: async () => {
    console.log("📥 Fetching raw unread emails...");

    const raw = await fetchEmails();

    if (!raw || !Array.isArray(raw.emails)) {
      console.error("❌ raw.emails is not an array. Type:", typeof raw.emails);
      return "Failed to fetch emails.";
    }

    const emails = raw.emails;
    console.log("📨 Fetched:", emails.length, "emails.");

    if (emails.length === 0) return "No unread emails.";

    emails.forEach(email => {
      storedEmails.set(email.uid, {
        uid: email.uid,
        subject: email.subject || "(No subject)",
        sender: email.sender || "Unknown",
        body: email.body || "",
        isRead: false,
        isProcessed: false,
        summary: null,
        classification: {
          priority: "unknown",
          category: "uncategorized"
        },
        status: "fetched"
      });
      
      showUser(email);
    });

    return [...storedEmails.values()].slice(0, 10); // return latest emails for display
  },
});

const markAsReadTool = new DynamicStructuredTool({
  name: "markAsRead",
  description: "Mark an email as read by UID.",
  schema: z.object({ uid: z.number() }),
  func: async ({ uid }) => {
    console.log("Marking as read...")
    const email = storedEmails.get(uid);
    if (!email) return { error: "Email not found." };

    try {
      const success = await markAsRead(uid);

      if (!success) {
        console.warn(`Could not mark email ${uid} as read.`);
        return { message: `Failed to mark email ${uid} as read.` };
      }

      const updated = { ...email, isRead: true, status: "read" };
      storedEmails.set(uid, updated);

      showUser(updated);
      return { message: `Email ${uid} marked as read.`, subject: email.subject };
    } catch (err) {
      console.error("Error marking as read:", err);
      return { error: "Unexpected error while marking email as read." };
    }
  },
});

const getStoredEmailsTool = new DynamicStructuredTool({
  name: "getStoredEmails",
  description: "Access previously fetched emails when needing to perform tasks on an emails",
  schema: z.object({}),
  func: async () => {
    console.log("Getting stored emails...")
    return JSON.stringify([...storedEmails.values()].slice(0, 10)); // limit for LLM
  },
});

const getEmailByIdTool = new DynamicStructuredTool({
  name: "getEmailById",
  description: "Retrieve a single stored email by UID.",
  schema: z.object({
    uid: z.number().describe("The UID of the email you want to retrieve."),
  }),
  func: async ({ uid }) => {
    console.log("Getting email by id...")

    const email = storedEmails.get(uid);

    if (!email) {
      return `No email found with UID ${uid}.`;
    }

    return email;
  },
});

const getEmailBySubjectTool = new DynamicStructuredTool({
  name: "getEmailBySubject",
  description: "Retrieve the first stored email that matches the given subject keyword.",
  schema: z.object({
    keyword: z.string().describe("A keyword or phrase from the email subject."),
  }),
  func: async ({ keyword }) => {
    console.log("Getting email by subject...")
    const match = [...storedEmails.values()].find(email =>
      email.subject.toLowerCase().includes(keyword.toLowerCase())
    );

    return {
      uid: match.uid,
      subject: match.subject,
      from: match.sender,
      preview: match.body?.slice(0, 200),
    };    
  },
});

const getEmailsByCategoryTool = new DynamicStructuredTool({
  name: "getEmailsByCategory",
  description: "Retrieve all stored emails that match the given category.",
  schema: z.object({
    category: z.string().describe("The category to filter emails by."),
  }),
  func: async ({ category }) => {
    console.log("Getting email by category...")
    const matches = [...storedEmails.values()].filter(
      email =>
        email.classification &&
        email.classification.category &&
        email.classification.category.toLowerCase() === category.toLowerCase()
    );

    return matches.slice(0, 10).map(email => ({
      uid: email.uid,
      subject: email.subject,
      classification: email.classification,
      preview: email.body?.slice(0, 200),
    }));    
  },
});

const processEmailTool = new DynamicStructuredTool({
  name: "processEmail",
  description: "Summarize and classify a single email by UID.",
  schema: z.object({
    uid: z.number().describe("The UID of the email to process."),
  }),
  func: async ({ uid }) => {
    const email = storedEmails.get(uid);
    if (!email) {
      return { error: "Email not found." };
    }

    const truncatedBody = email.body?.slice(0, 1000) || "";

    const summary = await summarizeEmail(truncatedBody);
    const classification = await classifyMessage(truncatedBody);

    // Update storedEmails map
    const updatedEmail = {
      ...email,
      summary,
      classification,
      isProcessed: true,
      status: "processed",
    };

    storedEmails.set(uid, updatedEmail);

    showUser(updatedEmail)

    return {
      uid,
      subject: email.subject,
      summary,
      classification,
      status: "processed",
    };
  },
});

const summarizeEmailTool = new DynamicStructuredTool({
  name: "summarizeMessage",
  description: "Use this to actually summarize an email. Do NOT assume a summary without calling this.",
  schema: z.object({ uid: z.number() }),
  func: async ({ uid }) => {
    const email = storedEmails.get(uid);
    if (!email) return { error: "Email not found." };

    const summary = await summarizeMessage(email.body.slice(0, 1000));

    const updated = {
      ...email,
      summary,
      isProcessed: true,
      status: email.status === "read" ? "read_processed" : "processed",
    };

    storedEmails.set(uid, updated);

    showUser(updated)

    return { uid, subject: email.subject, summary };
  },
});

const classifyEmailTool = new DynamicStructuredTool({
  name: "classifyEmail",
  description: "This classifies the email's priority and category. You MUST use this tool to classify, not guess.",
  schema: z.object({ uid: z.number() }),
  func: async ({ uid }) => {
    const email = storedEmails.get(uid);
    if (!email) return { error: "Email not found." };

    const classification = await classifyEmail(email.body.slice(0, 1000));

    const updated = {
      ...email,
      classification,
      isProcessed: true,
      status: email.status === "read" ? "read_processed" : "processed"
    };

    storedEmails.set(uid, updated);

    showUser(updated)

    return {
      uid,
      subject: email.subject,
      classification
    };
  }
});

const getEmailsByStatusTool = new DynamicStructuredTool({
  name: "getEmailsByStatus",
  description: "Retrieve stored emails by their current status.",
  schema: z.object({ status: z.string() }),
  func: async ({ status }) => {
    console.log("Getting email by status...")
    return [...storedEmails.values()].filter(email => email.status === status);
  },
});

const classifyAllStoredEmailsTool = new DynamicStructuredTool({
  name: "classifyAllStoredEmails",
  description: "Classify all currently stored emails that are not already classified.",
  schema: z.object({}),
  func: async () => {
    const results = [];
    console.log("Classifying ALL emails...")
    for (const email of storedEmails.values()) {
      if (
        email.classification.category === "uncategorized" ||
        email.classification.priority === "unknown"
      ) {
        const classification = await classifyMessage(email.body.slice(0, 1000));
        const updated = { ...email, classification, isProcessed: true };
        storedEmails.set(email.uid, updated);
        showUser(updated);
        results.push({
          uid: email.uid,
          subject: email.subject,
          classification
        });
      }
    }

    return results;
  }
});

const tools = [classifyAllStoredEmailsTool, processEmailTool, getEmailsByStatusTool, summarizeEmailTool, classifyEmailTool, processEmailTool, fetchEmailsTool, markAsReadTool, getStoredEmailsTool, getEmailByIdTool, getEmailsByCategoryTool, getEmailBySubjectTool];

import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createOpenAIToolsAgent } from "langchain/agents";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { pull } from "langchain/hub";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { SystemMessagePromptTemplate } from "@langchain/core/prompts";

const model = new ChatOpenAI({
  temperature: 0,
  modelName: process.env.OPENAI_MODEL,
});

const basePrompt = await pull("hwchase17/openai-tools-agent");
const prompt = ChatPromptTemplate.fromMessages([
  SystemMessagePromptTemplate.fromTemplate(`You are an AI email assistant.

Before summarizing, classifying, or marking an email as read, ALWAYS:
1. Use "getStoredEmails" to see what emails are in memory.
2. Use "classifyAllStoredEmails" to classify all emails if classification is needed.
3. Use "summarizeMessage" or "classifyEmail" to operate on a specific email.
4. DO NOT guess. Always use tools to get information or take action.
  `),
  ...basePrompt.promptMessages,
]);

const agent = await createOpenAIToolsAgent({
  llm: model,
  tools,
  prompt,
});

const executor = new AgentExecutor({
  agent,
  tools,
  verbose: false,
});

ipcMain.handle('submitPrompt', async (event, userInput) => {
  console.log("🔍 AI Agent processing prompt...");

  // Log chat history before adding the new user input
  console.log("Current chat history:", chatHistory);

  // Ensure the user input is added as a string
  chatHistory.push({ role: "user", content: userInput });

  // Ensure assistant's output is a string
  const result = await executor.invoke({
    input: userInput,
    chat_history: chatHistory,
  });

  // Make sure assistant's output is a string
  if (typeof result.output !== 'string') {
    console.warn("Warning: Assistant output is not a string:", result.output);
  }

  chatHistory.push({ role: "assistant", content: result.output });

  console.log("Finished processing.");
  console.log(result);

  // Log the updated chat history
  console.log("Updated chat history:", chatHistory);

  return result;
});

