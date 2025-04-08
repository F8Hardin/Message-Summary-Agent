import dotenv from 'dotenv';
dotenv.config();
import { app, BrowserWindow, ipcMain } from 'electron';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1080,
    minHeight: 720,
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
        showEmail(email);
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

function showEmail(data) {
    console.log("Sending email data to renderer.");
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('showEmail', data);
    });
}

function removeEmail(data) {
  console.log("Removing email data from renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('removeEmail', data);
  });
}

function showChat(data) {
  console.log("Sending chat data to renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('showChat', data);
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
    const clearedUIDKeys = result.cleared_UIDs
    console.log("Cleared UID keys:", clearedUIDKeys)

    //Display the LLM's readable response (not yet implemented on UI) - result.agent_message.content
    showChat({role: "Agent", message: result.agent_message.content})

    //iterate and show updated emails
    for (let i = 0; i < updatedUIDKeys.length; i++) {
      const key = updatedUIDKeys[i];
      const value = result.updated_UIDs[key];
      //console.log("Key:", key, "Value:", value);
      showEmail(value)
    }

    //iterate and remove cleared emails
    for (let i = 0; i < clearedUIDKeys.length; i++){
      removeEmail(clearedUIDKeys[i])
    }

    return result.agent_message;
  } catch (err) {
    console.error("Agent processing failed:", err);
    return "An error occurred while processing your prompt.";
  }
});


