const { ipcRenderer, ipcMain } = require('electron');

document.addEventListener("DOMContentLoaded", async () => {
    console.log("✅ DOM fully loaded!");

    const inputField = document.getElementById("chatInput");
    const submitButton = document.getElementById("submitPrompt");
    const emailDisplayArea = document.getElementById("emailList");
    const chatDisplayArea = document.getElementById("chatWindow")
    const categoryTabsContainer = document.getElementById("categoryTabs");
    const loadingWheel = document.getElementById("loader")

    if (!inputField || !submitButton || !emailDisplayArea || !categoryTabsContainer || !chatDisplayArea || !loadingWheel) {
        console.error("Error: Missing UI elements.");s
        return;
    }

    //loading categories
    try {
        const response = await fetch('categories.json');
        const categoryData = await response.json();
        const categories = categoryData.categories;

        console.log(categories)

        widthPercent = 100 / (categories.length) //plus 1 for "all"

        categories.forEach(category => {
            const tabElement = document.createElement("span");
            tabElement.classList.add("category-tab");
            tabElement.setAttribute("data-category", category);
            tabElement.style.width = widthPercent + "%";
            tabElement.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            categoryTabsContainer.appendChild(tabElement);
        });

        setupCategoryEventListeners();
    } catch (error) {
        console.error("Error loading categories:", error);
    }

    submitButton.addEventListener("click", async () => {
        const userInput = inputField.value.trim();
        inputField.value = '';
        
        if (userInput === "") {
            console.warn("Empty input ignored.");
            return;
        }

        ipcRenderer.emit("showChat", null, { "role" : "user", "message" : userInput})
        console.log("Submitting prompt:", userInput);

        submitButton.disabled = true
        loadingWheel.style.display = "block";

        try {
            await ipcRenderer.invoke("submitPrompt", userInput);
        } catch (error) {
            console.error("Error processing prompt:", error);
        }
        submitButton.disabled = false
        loadingWheel.style.display = "none";
    });

    ipcRenderer.on('showEmail', (event, data) => {
        console.log("Received email data from AI:", data);
    
        const email = data;
    
        // Remove existing entry by UID to avoid duplicates
        const existing = document.querySelector(`.email-entry[data-uid="${email.uid}"]`);
        if (existing) {
            existing.querySelector("h3").textContent = email.subject;
            existing.querySelector("p:nth-of-type(1)").innerHTML = `<strong>UID:</strong> ${email.uid}`;
            existing.querySelector("p:nth-of-type(2)").innerHTML = `<strong>Sender:</strong> ${email.sender || "Unknown"}`;
            existing.querySelector("p:nth-of-type(3)").innerHTML = `<strong>Read:</strong> ${email.isRead ? "Read" : "Unread"}`;
            existing.querySelector("p:nth-of-type(4)").innerHTML = `<strong>Status:</strong> ${email.status}`;
            existing.querySelector("p:nth-of-type(5)").innerHTML = `<strong>Processed:</strong> ${email.isProcessed ? "Yes" : "No"}`;
            existing.querySelector("p:nth-of-type(6)").innerHTML = `<strong>Summary:</strong> ${email.summary || "(Not summarized)"}`;
            existing.querySelector("p:nth-of-type(7)").innerHTML = `<strong>Priority:</strong> ${email.classification?.priority || "unknown"}`;
            existing.querySelector("p:nth-of-type(8)").innerHTML = `<strong>Category:</strong> ${email.classification?.category || "uncategorized"}`;
        } else {
            const emailElement = document.createElement("div");
            emailElement.setAttribute("data-uid", email.uid);
            emailElement.classList.add("email-entry");
            emailElement.setAttribute("data-category", email.classification?.category || "uncategorized");
        
            emailElement.innerHTML = `
                <h3>${email.subject}</h3>
                <p><strong>UID:</strong> ${email.uid}</p>
                <p><strong>Sender:</strong> ${email.sender || "Unknown"}</p>
                <p><strong>Read:</strong> ${email.isRead ? "Read" : "Unread"}</p>
                <p><strong>Status:</strong> ${email.status}</p>
                <p><strong>Processed:</strong> ${email.isProcessed ? "Yes" : "No"}</p>
                <p><strong>Summary:</strong> ${email.summary || "(Not summarized)"}</p>
                <p><strong>Priority:</strong> ${email.classification?.priority || "unknown"}</p>
                <p><strong>Category:</strong> ${email.classification?.category || "uncategorized"}</p>
        
                <div class="thumb-buttons">
                    <button class="thumb-up" data-subject="${email.subject}">👍</button>
                    <button class="thumb-down" data-subject="${email.subject}">👎</button>
                </div>
                <hr>
            `;
        
            emailDisplayArea.prepend(emailElement);
        }
        updateCategoryFilter();
    });

    ipcRenderer.on('showChat', (event, data) => {
        const chatElement = document.createElement("div");
        chatElement.classList.add("chatBubble");

        message = data.message;
        role = data.role;

        if (role == "Agent"){
            chatElement.id = "agentResponse"
        }
        else {
            chatElement.id = "chatSubmission"
        }

        chatElement.innerHTML = `
            <p>${data.message}</p>
        `;
        chatDisplayArea.append(chatElement)
    });
    
    function setupCategoryEventListeners() {
        const categoryTabs = document.querySelectorAll(".category-tab");
        categoryTabs.forEach(tab => {
            tab.addEventListener("click", () => {
                categoryTabs.forEach(t => t.classList.remove("active"));
                tab.classList.add("active");

                const selectedCategory = tab.getAttribute("data-category");
                filterEmails(selectedCategory);
            });
        });
    }

    function filterEmails(category) {
        const allEmailEntries = document.querySelectorAll(".email-entry");

        allEmailEntries.forEach(email => {
            if (category === "all" || email.getAttribute("data-category") === category) {
                email.style.display = "block";
            } else {
                email.style.display = "none";
            }
        });
    }

    function updateCategoryFilter() {
        const activeTab = document.querySelector(".category-tab.active");
        if (activeTab) {
            filterEmails(activeTab.getAttribute("data-category"));
        }
    }
});
