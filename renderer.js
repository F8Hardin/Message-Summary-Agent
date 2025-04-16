const { ipcRenderer, ipcMain } = require('electron');
const { read } = require('fs');

document.addEventListener("DOMContentLoaded", async () => {
    console.log("✅ DOM fully loaded!");

    let currentDisplayedEmail = null;

    const inputField = document.getElementById("chatInput");
    const submitButton = document.getElementById("submitPrompt");
    const emailDisplayArea = document.getElementById("emailList");
    const chatDisplayArea = document.getElementById("chatWindow")
    const categoryTabsContainer = document.getElementById("categoryTabs");
    const loadingWheel = document.getElementById("submit_loader")
    const processingElement = document.getElementById("processingMessage");
    const emailCloseButton = document.getElementById("closeEmailDetail");
    const emailToggleReadButton = document.getElementById("toggleReadEmailDetail")   

    if (!inputField || !submitButton || !emailDisplayArea || !categoryTabsContainer || !chatDisplayArea || !loadingWheel || !processingElement) {
        console.error("Error: Missing UI elements.");s
        return;
    }

    //loading categories
    try {
        const response = await fetch('categories.json');
        const categoryData = await response.json();
        const categories = categoryData.categories;0.

        console.log(categories)

        categories.forEach(category => {
            const tabElement = document.createElement("span");
            tabElement.classList.add("category-tab");
            tabElement.setAttribute("data-category", category);
            tabElement.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            categoryTabsContainer.appendChild(tabElement);
        });

        setupCategoryEventListeners();
    } catch (error) {
        console.error("Error loading categories:", error);
    }

    function updateEmailReadStatus(uid, isRead) {
        if (!currentDisplayedEmail || currentDisplayedEmail.getAttribute("data-uid") !== uid) return;
    
        currentDisplayedEmail.setAttribute("data-isRead", isRead ? "read" : "unread");

        emailToggleReadButton.innerText = isRead ? "Mark as Unread" : "Mark as Read";
    
        const readField = currentDisplayedEmail.querySelector("p:nth-of-type(3)");
        if (readField) {
            readField.innerHTML = `<strong>Read:</strong> ${isRead ? "Read" : "Unread"}`;
        }
        updateCategoryFilter();
    }

    emailCloseButton.addEventListener("click", () => {
        document.getElementById("emailDetailOverlay").style.display = "none";
        currentDisplayedEmail?.classList.remove("selected");
        currentDisplayedEmail = null;
        chatDisplayArea.style.overflow = "hidden"
    });

    emailToggleReadButton.addEventListener("click", async () => {
        let readStatus = currentDisplayedEmail.getAttribute("data-isRead");
        let uid = currentDisplayedEmail.getAttribute("data-uid");
    
        let res = null;
        let success = false;
    
        try {
            if (readStatus === "unread") {
                res = await ipcRenderer.invoke("markAsRead", uid);
            } else {
                res = await ipcRenderer.invoke("unmarkAsRead", uid);
            }
    
            // Check if the response includes a valid UID and status
            if (res && res.uid == uid && typeof res.isRead === "boolean") {
                updateEmailReadStatus(uid, res.isRead);
                success = true;
            }
        } catch (error) {
            console.error("Failed to toggle read status:", error);
        }
    
        if (!success) {
            console.warn("Email read/unread update failed or returned unexpected result:", res);
        }
    });    

    submitButton.addEventListener("click", async () => {
        const userInput = inputField.value.trim();
        inputField.value = '';
        
        if (userInput === "") {
            console.warn("Empty input ignored.");
            return;
        }

        ipcRenderer.emit("showChat", null, { "role" : "user", "message" : userInput})
        ipcRenderer.emit("showProcessing", null, "Processing input...")
        console.log("Submitting prompt:", userInput);

        try {
            await ipcRenderer.invoke("submitPrompt", userInput);
        } catch (error) {
            console.error("Error processing prompt:", error);
        }

        ipcRenderer.emit("removeProcessing");
    });

    ipcRenderer.on('showEmail', (event, data) => {
        console.log("Received email data from AI:", data.summary);
    
        const email = data;
    
        // Remove existing entry by UID to avoid duplicates
        const existing = document.querySelector(`.email-entry[data-uid="${email.uid}"]`);
        if (existing) {
            existing.querySelector("h3").textContent = email.subject;
            existing.querySelector("p:nth-of-type(1)").innerHTML = `<strong>Sender:</strong> ${email.sender || "Unknown"}`;
            existing.querySelector("p:nth-of-type(2)").innerHTML = `<strong>Summary:</strong> ${email.summary || "(Not summarized)"}`;
            existing.querySelector("p:nth-of-type(3)").innerHTML = `<strong>Read:</strong> ${email.isRead ? "Read" : "Unread"}`;

            existing.setAttribute("data-category", email.classification?.category?.toLowerCase() || "uncategorized");
            existing.setAttribute("data-priority", email.classification?.priority?.toLowerCase() || "unknown");
            existing.setAttribute("data-isRead", email.isRead ? "read" : "unread");

            existing.querySelector("p:nth-of-type(4)").innerHTML = `<strong>Priority:</strong> ${email.classification?.priority || "unknown"}`;
            existing.querySelector("p:nth-of-type(5)").innerHTML = `<strong>Category:</strong> ${email.classification?.category || "uncategorized"}`;
        } else {
            const emailElement = document.createElement("div");
            emailElement.setAttribute("data-uid", email.uid);
            emailElement.classList.add("email-entry");
            emailElement.setAttribute("data-category", email.classification?.category || "uncategorized");
            emailElement.setAttribute("data-priority", email.classification?.priority || "unknown");
            emailElement.setAttribute("data-isRead", email.isRead ? "read" : "unread");         
        
            emailElement.innerHTML = `
                <h3>${email.subject}</h3>
                <p><strong>Sender:</strong> ${email.sender || "Unknown"}</p>
                <p><strong>Summary:</strong> ${email.summary || "(Not summarized)"}</p>
                <p><strong>Read:</strong> ${email.isRead ? "Read" : "Unread"}</p>
                <p><strong>Priority:</strong> ${email.classification?.priority || "unknown"}</p>
                <p><strong>Category:</strong> ${email.classification?.category || "uncategorized"}</p>
        
                <div class="thumb-buttons">
                    <button class="thumb-up">👍</button>
                    <button class="thumb-down">👎</button>
                </div>
                <hr>
            `;

            emailElement.addEventListener("click", () => {
                currentDisplayedEmail?.classList.remove("selected");
                const isRead = emailElement.getAttribute("data-isRead") === "read";
                emailToggleReadButton.innerText = isRead ? "Mark as Unread" : "Mark as Read";                
                showEmailDetail(email);
                emailElement.classList.add("selected");
                currentDisplayedEmail = emailElement
                chatDisplayArea.style.overflow = "hidden"
            });     
        
            emailDisplayArea.prepend(emailElement);
        }
        updateCategoryFilter();
    });

    ipcRenderer.on('removeEmail', (event, data) => {
        console.log("Removing assocaited email:", data);
        const existing = document.querySelector(`.email-entry[data-uid="${data}"]`);
        existing.remove()
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

    ipcRenderer.on('showProcessing', (event, data) => {
        if (processingElement) {
            chatDisplayArea.style.overflow = "hidden"
            processingElement.innerText = data.message;
            processingElement.style.display = "block";
            submitButton.disabled = true;
            loadingWheel.style.display = "block";
        }
    });
      
    ipcRenderer.on('removeProcessing', () => {
        if (processingElement) {
            chatDisplayArea.style.overflowY = "scroll";
            processingElement.style.display = "none";
            submitButton.disabled = false;
            loadingWheel.style.display = "none"
        }
    });

    function showEmailDetail(email) {
        const overlay = document.getElementById("emailDetailOverlay");
        const iframe = document.getElementById("emailRawViewer");
      
        if (overlay && iframe) {
            overlay.style.display = "flex";
            iframe.srcdoc = email.raw_body || "<p>No content</p>";
        }
    }   
    
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
            console.log(email.getAttribute("data-isRead"))
            if (category === "all" 
            || email.getAttribute("data-category") === category 
            || email.getAttribute("data-priority") === category
            || email.getAttribute("data-isRead") === category) {
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