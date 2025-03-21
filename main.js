const { app, BrowserWindow, ipcMain } = require('electron/main')
const Imap = require('imap-simple');
const fs = require('fs');

const LlmApiWrapper = require("./LlmApiWrapper.js");

const startPrompt = "Please get my unread emails and process them."

let categories = [];
try {
  const categoryData = fs.readFileSync('categories.json');
  categories = JSON.parse(categoryData).categories;
  console.log("Loaded categories:", categories);
} catch (error) {
  console.error("Error loading categories:", error);
}

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const createWindow = () => {
  const win = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
          nodeIntegration: true, //need to swap to payload for production
          contextIsolation: false,
          enableRemoteModule: true,
      },
  });

  win.loadFile('index.html')
};

app.whenReady().then(() => {
  createWindow();

  console.log("Fetching emails on startup...");

  if (process.env.LMSTUDIO_AGENT){
    console.log("Using LM Studio agent...")
    agent(startPrompt)
  } else { //open ai agent
    console.log("Using open ai agent...")
    llm.callOpenAIAgent(startPrompt)
  }

  // setInterval(() => {
  //     console.log("Checking for new emails...");
  //     llm.callOpenAIAgent("Check for new emails and process them for me.")
  // }, 5 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function getEmails() {
  console.log("Fetching unread emails...");

  const config = {
      imap: {
          user: process.env.EMAIL_USER,
          password: process.env.EMAIL_PASS,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          authTimeout: 3000,
          tlsOptions: {
              rejectUnauthorized: false,
          }
      }
  };

  try {
      const connection = await Imap.connect(config);
      await connection.openBox('INBOX');

      const searchCriteria = ['UNSEEN'];
      const fetchOptions = { bodies: ['HEADER.FIELDS (SUBJECT)', 'TEXT'], struct: true };

      const messages = await connection.search(searchCriteria, fetchOptions);
      const emails = messages.map(msg => ({
          uid: msg.attributes.uid,
          subject: cleanText(msg.parts.find(part => part.which === 'HEADER.FIELDS (SUBJECT)').body.subject[0]),
          body: cleanEmailBody(msg.parts.find(part => part.which === 'TEXT').body),
      }));

      connection.end();
      console.log(`✅ Retrieved ${emails.length} unread emails.`);

      // 🔹 Return emails in a structured way so OpenAI knows it should process each one
      return {
          count: emails.length,
          emails: emails.map(email => ({
              subject: email.subject,
              body: email.body,
              uid: email.uid
          })),
      };
  } catch (error) {
      console.error("Error fetching emails:", error);
      return { count: 0, emails: [] };
  }
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim(); // ✅ Remove extra spaces
}

function cleanEmailBody(emailBody) {
  if (!emailBody) return "";

  emailBody = emailBody.replace(/<\/?[^>]+(>|$)/g, "");

  emailBody = emailBody.split("-- ").shift();
  emailBody = emailBody.split("Sent from my").shift();

  const replyMarkers = ["On ", "wrote:", "From:", "Subject:"];
  replyMarkers.forEach(marker => {
      const index = emailBody.indexOf(marker);
      if (index > 0) emailBody = emailBody.substring(0, index);
  });

  if (emailBody.length > 1000) {
      emailBody = emailBody.substring(0, 1000) + "...";
  }

  return emailBody.trim();
}

async function summarizeMessage(messageBody) {
  console.log("Summarizing message...");
  return await llm.callLLM("Summarize the following message in a few sentences." + messageBody, tools);
}

async function classifyMessage(messageBody) {
  console.log("📌 Classifying email...");

  const categoriesList = categories.join('", "');

  const systemPrompt = `
      You are an AI assistant that classifies emails. 
      Classify the email into:
      - **Priority**: "important" or "not important".
      - **Category**: one of the following: "${categoriesList}".

      Return your response as a JSON object like this:
      {
          "priority": "important",
          "category": "work"
      }
  `;

  return await llm.callLLM(systemPrompt + messageBody, tools);
}

async function processEmail(email) {
  console.log(`📩 Processing email: "${email.subject}"`);

  const truncatedEmail = email.body.length > 1000 ? email.body.slice(0, 1000) + "..." : email.body;

  const summary = await summarizeMessage(truncatedEmail);
  
  const classification = await classifyMessage(truncatedEmail);

  console.log(`Summary: ${summary}`);
  console.log(`Classification: ${JSON.stringify(classification)}`);

  return {
      subject: email.subject,
      summary,
      classification
  };
}

async function markAsRead(emailUID) {
  console.log(`Attempting to mark email ${emailUID} as read...`);

  if (!emailUID) {
      console.error("Error: No UID provided for marking as read.");
      return;
  }

  const config = {
      imap: {
          user: process.env.EMAIL_USER,
          password: process.env.EMAIL_PASS,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          authTimeout: 3000,
          tlsOptions: {
              rejectUnauthorized: false,
          },
      },
  };

  try {
      const connection = await Imap.connect(config);
      await connection.openBox('INBOX');

      console.log(`Checking if email with UID ${emailUID} exists...`);
      const searchCriteria = [emailUID];
      const fetchOptions = { bodies: [] };
      const messages = await connection.search(searchCriteria, fetchOptions);

      if (messages.length === 0) {
          console.error(`❌ No matching email found for UID: ${emailUID}`);
          connection.end();
          return;
      }

      console.log(`Email found. Adding "\\Seen" flag to mark as read...`);
      await connection.addFlags(emailUID, ['\\Seen']);

      console.log(`Successfully marked email ${emailUID} as read.`);
      connection.end();
  } catch (error) {
      console.error("Error marking email as read:", error);
  }
}


function showUser(data) {
  console.log("Sending data to renderer:", data);
  BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('showUser', data);
  });
}

const tools = [
  {
    type: "function",
    function: {
      name: "getEmails",
      description: "Fetch unread emails.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
        name: "processEmail",
        description: "Summarize and classify a specific email. If there are multiple emails, call this function multiple times - once per email.",
        parameters: {
            type: "object",
            properties: {
                email: {
                    type: "object",
                    properties: {
                        subject: { type: "string" },
                        body: { type: "string" }
                    },
                    required: ["subject", "body"]
                }
            },
            required: ["email"],
        },
    },
  },
  {
    type: "function",
    function: {
      name: "markAsRead",
      description: "Marks an email as read. If there are multiple emails, call this function multiple times - once per email.",
      parameters: {
        type: "object",
        properties: {
          emailUID: {
            type: "string",
          },
        },
        required: ["emailUID"],
      },
    },
  },
  {
    type: "function",
    function: {
        name: "showUser",
        description: "Send processed email summaries and classifications to the user for display in the UI. Use after processing an email.",
        parameters: {
            type: "object",
            properties: {
                emails: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            subject: { type: "string" },
                            summary: { type: "string" },
                            classification: {
                                type: "object",
                                properties: {
                                    priority: { type: "string" },
                                    category: { type: "string" }
                                },
                                required: ["priority", "category"]
                            }
                        },
                        required: ["subject", "summary", "classification"]
                    }
                }
            },
            required: ["emails"],
        },
    }
  }
];

const availableTools = [
  showUser,
  markAsRead,
  getEmails,
  processEmail
]

const llm = new LlmApiWrapper(tools);

async function agent(userInput) {
  for (let i = 0; i < process.env.MAX_ITERATIONS; i++) {
      console.log(`AI Processing Step ${i + 1}...`);

      const { aiResponse, toolCalls } = await llm.callLmstudioAgent(userInput, tools);

      console.log("AI Response:", aiResponse);

      let newUserInput = aiResponse;
      let processedEmails = [];

      if (toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
              const functionName = toolCall.function.name;
              const functionArgs = toolCall.function.arguments || {};
              const functionArgsArr = Object.values(functionArgs);

              console.log(`Calling function: ${functionName}`);
              const functionToCall = availableTools.find(tool => tool.name === functionName)

              if (!functionToCall) {
                  console.error(`Function "${functionName}" not found.`);
                  return `Error: Function "${functionName}" not found.`;
              }

              try {
                  const functionResponse = await functionToCall.apply(null, functionArgsArr);
                  console.log(`Function ${functionName} executed successfully!`);
                  console.log("Function response:", functionResponse);

                  if (functionName === "processEmail") {
                      processedEmails.push(functionResponse);
                  }

                  llm.addMessage({
                      role: "function",
                      name: functionName,
                      content: JSON.stringify(functionResponse),
                  });

                  newUserInput += "\nFunction ${functionName} returned: ${JSON.stringify(functionResponse)}";

              } catch (error) {
                  console.error(`Error executing function "${functionName}":`, error);
                  return `Error executing function "${functionName}".`;
              }
          }

          if (processedEmails.length > 0) {
              console.log("Sending processed emails to UI...");
              showUser({ emails: processedEmails });
          }
      }

      if (toolCalls.length === 0) {
          console.log("AI completed reasoning.");
          llm.addMessage({ role: "assistant", content: aiResponse });
          return aiResponse;
      }

      userInputclsd = newUserInput
  }

  console.log("Max iterations reached. Stopping agent.");
  return "Agent stopped due to max iterations.";
}

ipcMain.handle('submitPrompt', async (event, userInput) => {
  console.log("🔍 AI Agent processing prompt...");

  if (process.env.LMSTUDIO_AGENT){
    const result = agent(userInput)
  } else { //open ai agent
    const result = llm.callOpenAIAgent(userInput)
  }
  return result;
});