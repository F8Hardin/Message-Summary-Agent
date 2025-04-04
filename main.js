import dotenv from 'dotenv';
dotenv.config();
import { app, BrowserWindow, ipcMain } from 'electron';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      nodeIntegration: true, // For quick development, use preload for prod
      contextIsolation: false,
      // preload: path.join(__dirname, 'preload.js'), // Uncomment if using a preload script
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  createWindow();

  try {
    console.log("Fetching emails...")
    //fetch emails - getting new ones
    await fetch(process.env.PYAGENT_ENDPOINT + "/fetchEmails", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    //get the stored emails after fetching
    const res = await fetch(process.env.PYAGENT_ENDPOINT + "/getStoredEmails", {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    const emails = await res.json();

    //show emails
    if (Array.isArray(emails)) {
      emails.forEach(email => {
        showUser(email);
      });
    } else {
      console.warn("Unexpected response from getStoredEmails:", emails);
    }
  } catch (err) {
    console.error("Error during email initialization:", err);
  }

  app.on("activate", () => {
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

ipcMain.handle('submitPrompt', async (event, userInput) => {
  console.log("🔍 AI Agent processing prompt...");

  try {
    // Send user input to the agent API
    const res = await fetch(process.env.PYAGENT_ENDPOINT + "/promptAgent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_input: userInput }),
    });
    const result = await res.json();
    console.log("Agent Message:", result.agent_message.content);
    console.log("UIDs:", result.updated_UIDs)
    const updatedUIDKeys = Object.keys(result.updated_UIDs);
    console.log("Updated UID Keys:", updatedUIDKeys);

    //Display the LLM's readable response (not yet implemented on UI) - result.agent_message.content

    //iterate and show updated emails
    for (let i = 0; i < updatedUIDKeys.length; i++) {
      const key = updatedUIDKeys[i];
      const value = result.updated_UIDs[key];
      //console.log("Key:", key, "Value:", value);
      showUser(value)
    }


    return result.agent_message;
  } catch (err) {
    console.error("Agent processing failed:", err);
    return "An error occurred while processing your prompt.";
  }
});


