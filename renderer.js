const { ipcRenderer } = require('electron');

document.addEventListener("DOMContentLoaded", async () => {
    console.log("✅ DOM fully loaded!");

    const inputField = document.getElementById("promptInput");
    const submitButton = document.getElementById("submitPrompt");
    const displayArea = document.getElementById("emailDisplay");
    const categoryTabsContainer = document.getElementById("categoryTabs");

    if (!inputField || !submitButton || !displayArea || !categoryTabsContainer) {
        console.error("Error: Missing UI elements.");s
        return;
    }

    let allEmails = [];

    try {
        const response = await fetch('categories.json');
        const categoryData = await response.json();
        const categories = categoryData.categories;

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

    submitButton.addEventListener("click", async () => {
        const userInput = inputField.value.trim();
        inputField.value = '';
        
        if (userInput === "") {
            console.warn("Empty input ignored.");
            return;
        }

        console.log("Submitting prompt:", userInput);

        try {
            await ipcRenderer.invoke("submitPrompt", userInput);
        } catch (error) {
            console.error("Error processing prompt:", error);
        }
    });

    ipcRenderer.on('showUser', (event, data) => {
        console.log("Received email data from AI:", data);
    
        const email = data;
    
        // Remove existing entry by UID to avoid duplicates
        const existing = document.querySelector(`.email-entry[data-uid="${email.uid}"]`);
        if (existing) {
            existing.remove();
        }
    
        const emailElement = document.createElement("div");
        emailElement.setAttribute("data-uid", email.uid);
        emailElement.classList.add("email-entry");
        emailElement.setAttribute("data-category", email.classification?.category || "uncategorized");
    
        emailElement.innerHTML = `
            <h3>${email.subject}</h3>
            <p><strong>UID:</strong> ${email.uid}</p>
            <p><strong>Sender:</strong> ${email.sender || "Unknown"}</p>
            <p><strong>Read:</strong> ${email.isRead ? "✅ Read" : "📩 Unread"}</p>
            <p><strong>Status:</strong> ${email.status}</p>
            <p><strong>Processed:</strong> ${email.isProcessed ? "✔️ Yes" : "❌ No"}</p>
            <p><strong>Summary:</strong> ${email.summary || "(Not summarized)"}</p>
            <p><strong>Priority:</strong> ${email.classification?.priority || "unknown"}</p>
            <p><strong>Category:</strong> ${email.classification?.category || "uncategorized"}</p>
    
            <div class="thumb-buttons">
                <button class="thumb-up" data-subject="${email.subject}">👍</button>
                <button class="thumb-down" data-subject="${email.subject}">👎</button>
            </div>
            <hr>
        `;
    
        displayArea.appendChild(emailElement);
        updateCategoryFilter();
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
