// QueueLess frontend connected to the Node.js API.
const API_BASE = "";

const SERVICES = [
    "Student Services",
    "Accounts",
    "Examination Cell",
    "Library",
    "Administration",
    "IT Support"
];

const PREFIXES = {
    "Student Services": "A",
    "Accounts": "B",
    "Examination Cell": "C",
    "Library": "D",
    "Administration": "E",
    "IT Support": "F"
};

let currentUser = null;
let queueRows = [];
let currentTokenId = null;

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        credentials: "same-origin",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    let data = {};
    try {
        data = await response.json();
    } catch (_) { }

    if (!response.ok) {
        throw new Error(
            data.error || data.message || `Request failed (${response.status})`
        );
    }

    return data;
}

function safeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[ch]);
}

function tokenLabel(row) {
    const service = row.service_type || row.serviceType || "";
    const prefix = PREFIXES[service] || "";
    return `${prefix}${String(row.id).padStart(3, "0")}`;
}

function statusClass(status) {
    const value = String(status || "").toLowerCase();

    if (value === "completed") return "completed";
    if (value === "serving") return "serving";
    return "waiting";
}

function showMessage(message) {
    let element = document.getElementById("queueMessage");

    if (!element) {
        element = document.createElement("p");
        element.id = "queueMessage";
        element.setAttribute("role", "status");

        const main = document.querySelector("main");
        if (main) main.prepend(element);
    }

    if (element) element.textContent = message;
}

async function takeToken(department) {
    if (!SERVICES.includes(department)) {
        showMessage("Invalid department.");
        return;
    }

    if (!currentUser) {
        window.location.href = "/login.html";
        return;
    }

    try {
        const result = await apiRequest("/api/queue", {
            method: "POST",
            body: JSON.stringify({
                studentName: currentUser.fullName,
                serviceType: department
            })
        });

        if (!result.tokenNumber) {
            throw new Error("The server did not return a token number.");
        }

        localStorage.setItem(
            "queuelessLastTokenId",
            String(result.tokenNumber)
        );

        showMessage(
            `Token ${PREFIXES[department]}${String(result.tokenNumber).padStart(3, "0")} created successfully!`
        );

        await refreshStudentQueue();
    } catch (error) {
        showMessage(`Could not create token: ${error.message}`);
    }
}
async function refreshStudentQueue() {
    if (!currentUser) return;

    try {
        // All department tokens are needed to calculate queue position.
        const allRowsResponse = await apiRequest("/api/queue");
        queueRows = Array.isArray(allRowsResponse)
            ? allRowsResponse
            : [];

        // Fetch only the tokens belonging to the logged-in student.
        const myRowsResponse = await apiRequest("/api/my-queue");
        const myRows = Array.isArray(myRowsResponse)
            ? myRowsResponse
            : Array.isArray(myRowsResponse.tokens)
                ? myRowsResponse.tokens
                : [];
        const lastId = Number(
            localStorage.getItem("queuelessLastTokenId")
        );

        const isActive = row =>
            !["completed", "cancelled"].includes(
                String(row.status || "").toLowerCase()
            );

        // Select the saved token only if it is active.
        let myRow = myRows.find(
            row => Number(row.id) === lastId && isActive(row)
        );

        // Otherwise, select the newest active token.
        if (!myRow) {
            myRow = [...myRows]
                .filter(isActive)
                .sort((a, b) => Number(b.id) - Number(a.id))[0];
        }

        // If there are no active tokens, show the latest token in history.
        if (!myRow && myRows.length) {
            myRow = [...myRows].sort(
                (a, b) => Number(b.id) - Number(a.id)
            )[0];
        }


        currentTokenId = myRow ? Number(myRow.id) : null;

        const currentService = myRow
            ? (myRow.service_type || myRow.serviceType)
            : "";

        const serviceRows = currentService
            ? queueRows.filter(row =>
                (row.service_type || row.serviceType) === currentService
            )
            : [];

        const current = serviceRows.find(row =>
            String(row.status || "").toLowerCase() === "serving"
        );

        const peopleAhead = myRow &&
            String(myRow.status || "").toLowerCase() === "waiting"
            ? serviceRows.filter(row =>
                Number(row.id) < Number(myRow.id) &&
                String(row.status || "").toLowerCase() === "waiting"
            ).length
            : 0;

        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        };

        setText("currentToken", current ? tokenLabel(current) : "—");
        setText("myToken", myRow ? tokenLabel(myRow) : "—");
        setText("peopleAhead", peopleAhead);
        setText("waitTime", `${peopleAhead * 5} min (estimate)`);

        const bigToken = document.querySelector(".big-token");
        if (bigToken) {
            bigToken.textContent = myRow
                ? tokenLabel(myRow)
                : "No active token";
        }

        const details = document.querySelector(".token-details");

        if (details) {
            if (myRow) {
                details.innerHTML = `
                    <p><strong>Department:</strong> ${safeText(currentService)}</p>
                    <p><strong>Status:</strong>
                        <span class="${statusClass(myRow.status)}">
                            ${safeText(myRow.status)}
                        </span>
                    </p>
                    <p><strong>Current Token:</strong>
                        ${safeText(current ? tokenLabel(current) : "—")}
                    </p>
                    <p><strong>People Ahead:</strong> ${peopleAhead}</p>
                `;
            } else {
                details.textContent = "You do not have a token yet.";
            }
        }

        // Update department cards with their currently serving tokens.
        document.querySelectorAll(".department-card").forEach(card => {
            const heading = card.querySelector("h3");
            const status = card.querySelector(".department-status strong");

            if (!heading || !status) return;

            const service = heading.textContent.trim();

            const serving = queueRows.find(row =>
                (row.service_type || row.serviceType) === service &&
                String(row.status || "").toLowerCase() === "serving"
            );

            status.textContent = serving ? tokenLabel(serving) : "—";
        });

        renderHistory(myRows);

        // Allow cancellation only while this token is waiting.
        const cancelButton = document.querySelector(".cancel-button");

        if (cancelButton) {
            const isWaiting = myRow &&
                String(myRow.status || "").toLowerCase() === "waiting";

            cancelButton.disabled = !isWaiting;
            cancelButton.title = isWaiting
                ? "Cancel your waiting token"
                : "Only waiting tokens can be cancelled";
        }
    } catch (error) {
        console.error("Queue refresh failed:", error);
        showMessage(`Could not refresh queue: ${error.message}`);
    }
}


function renderHistory(rows) {
    const tbody = document.querySelector("#history tbody");
    if (!tbody) return;

    const sorted = [...rows].sort(
        (a, b) => Number(b.id) - Number(a.id)
    );

    if (!sorted.length) {
        tbody.innerHTML =
            '<tr><td colspan="4">No token history yet.</td></tr>';
        return;
    }

    tbody.innerHTML = sorted.map(row => {
        const date = row.created_at
            ? new Date(row.created_at).toLocaleDateString()
            : "—";

        return `
      <tr>
        <td>${safeText(tokenLabel(row))}</td>
        <td>${safeText(row.service_type || row.serviceType || "")}</td>
        <td>${safeText(date)}</td>
        <td>
          <span class="${statusClass(row.status)}">
            ${safeText(row.status || "Waiting")}
          </span>
        </td>
      </tr>
    `;
    }).join("");
}
async function cancelToken() {
    if (!currentUser) {
        window.location.href = "/login.html";
        return;
    }

    if (!currentTokenId) {
        showMessage("No token is selected to cancel.");
        return;
    }

    const confirmed = window.confirm(
        "Are you sure you want to cancel your waiting token?"
    );

    if (!confirmed) return;

    const cancelButton = document.querySelector(".cancel-button");

    try {
        if (cancelButton) cancelButton.disabled = true;

        await apiRequest(`/api/queue/${currentTokenId}/cancel`, {
            method: "PUT"
        });

        localStorage.removeItem("queuelessLastTokenId");

        showMessage("Your token has been cancelled successfully.");

        await refreshStudentQueue();
    } catch (error) {
        showMessage(`Could not cancel token: ${error.message}`);
        await refreshStudentQueue();
    }
}

async function logout() {
    try {
        await apiRequest("/api/logout", { method: "POST" });
    } catch (error) {
        console.error("Logout error:", error);
    }

    window.location.href = "/login.html";
}

function staffLogout() {
    logout();
}

function adminLogout() {
    logout();
}
async function loadStaffQueue() {
    const table = document.getElementById("queueTable");
    if (!table) return;

    try {
        const response = await apiRequest("/api/queue");
        const rows = Array.isArray(response) ? response : [];

        const department = document.getElementById("department");
        const chosen = department ? department.value : "";

        const visible = chosen
            ? rows.filter(row =>
                (row.service_type || row.serviceType) === chosen
            )
            : rows;

        // Update the queue table
        table.innerHTML = visible.length
            ? visible.map(row => `
                <tr>
                    <td>${safeText(tokenLabel(row))}</td>
                    <td>${safeText(row.student_name || "")}</td>
                    <td>${safeText(row.service_type || row.serviceType || "")}</td>
                    <td>${safeText(row.created_at
                ? new Date(row.created_at).toLocaleTimeString()
                : "—")}</td>
                    <td>${safeText(row.status || "Waiting")}</td>
                </tr>
            `).join("")
            : '<tr><td colspan="5">No queue tokens found.</td></tr>';

        // Find the token currently being served
        const servingToken = visible.find(row =>
            String(row.status || "").toLowerCase() === "serving"
        );

        // Update NOW SERVING
        const nowServing = document.getElementById("nowServing");
        const nowServingDepartment =
            document.getElementById("nowServingDepartment");

        if (nowServing) {
            nowServing.textContent = servingToken
                ? tokenLabel(servingToken)
                : "—";
        }

        if (nowServingDepartment) {
            nowServingDepartment.textContent = servingToken
                ? (servingToken.service_type ||
                    servingToken.serviceType || chosen)
                : `No token serving${chosen ? " in " + chosen : ""}`;
        }

        // Update dashboard summary counts
        const waitingCount = document.getElementById("waitingCount");
        const completedCount = document.getElementById("completedCount");
        const totalTokens = document.getElementById("totalTokens");
        const staffCurrentToken = document.getElementById("staffCurrentToken");

        const waiting = visible.filter(row =>
            String(row.status || "").toLowerCase() === "waiting"
        ).length;

        const completed = visible.filter(row =>
            String(row.status || "").toLowerCase() === "completed"
        ).length;

        if (waitingCount) waitingCount.textContent = waiting;
        if (completedCount) completedCount.textContent = completed;
        if (totalTokens) totalTokens.textContent = visible.length;

        if (staffCurrentToken) {
            staffCurrentToken.textContent = servingToken
                ? tokenLabel(servingToken)
                : "—";
        }

    } catch (error) {
        table.innerHTML =
            `<tr><td colspan="5">${safeText(error.message)}</td></tr>`;
        console.error("Staff queue refresh failed:", error);
    }
}
// Keep the existing staff dashboard functions available.

async function advanceQueue(actionLabel = "Advance queue") {
    const departmentSelect = document.getElementById("department");
    const department = departmentSelect?.value;

    if (!department) {
        alert("Please select a department first.");
        return;
    }

    try {
        const result = await apiRequest("/api/queue/next", {
            method: "PUT",
            body: JSON.stringify({ department })
        });

        alert(result.message || `${actionLabel} completed.`);

        await loadStaffQueue();
    } catch (error) {
        alert(`${actionLabel} failed: ${error.message}`);
    }
}


function callNextToken() {
    advanceQueue("Call next");
}

function completeToken() {
    advanceQueue("Complete current token and call next");
}

function skipToken() {
    alert("Skipping a token is not supported by the current backend.");
}

function showQueueMessage() {
    refreshStudentQueue();
}

function addDepartment() {
    alert("Department management is not connected yet.");
}

function addStaff() {
    alert("Staff management is not connected yet.");
}

function viewUsers() {
    const element = document.getElementById("users");
    if (element) element.scrollIntoView({ behavior: "smooth" });
    else alert("User management is not connected yet.");
}

function editDepartment(name) {
    alert(`${name} management is not connected yet.`);
}
document.addEventListener("DOMContentLoaded", async () => {
    // STAFF DASHBOARD
    if (document.getElementById("queueTable")) {
        await loadStaffQueue();

        const select = document.getElementById("department");

        if (select) {
            select.addEventListener("change", loadStaffQueue);
        }

        // Automatically refresh the staff queue every 5 seconds.
        setInterval(() => {
            loadStaffQueue();
        }, 5000);
    }

    // STUDENT DASHBOARD
    if (document.getElementById("myToken")) {
        try {
            const result = await apiRequest("/api/me");
            currentUser = result.user;

            await refreshStudentQueue();

            // Automatically refresh the student dashboard every 5 seconds.
            setInterval(() => {
                refreshStudentQueue();
            }, 5000);
        } catch (error) {
            window.location.href = "/login.html";
        }
    }
});

// =========================
// QUEUELESS AI CHAT
// =========================

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("aiForm");
    const input = document.getElementById("aiInput");
    const messages = document.getElementById("aiMessages");
    const sendButton = document.getElementById("aiSendButton");

    if (!form || !input || !messages || !sendButton) return;

    function addMessage(text, className) {
        const message = document.createElement("div");
        message.className = `ai-message ${className}`;
        message.textContent = text;
        messages.appendChild(message);
        messages.scrollTop = messages.scrollHeight;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const message = input.value.trim();
        if (!message || message.length > 1000) return;

        addMessage(message, "ai-user");

        input.value = "";
        input.disabled = true;
        sendButton.disabled = true;
        sendButton.textContent = "Thinking...";

        try {
            const response = await fetch("/api/ai/chat", {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ message })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "AI assistant request failed.");
            }

            addMessage(data.reply || "I couldn't generate a response.", "ai-bot");

        } catch (error) {
            addMessage(
                error.message || "Unable to connect to QueueLess AI. Please try again.",
                "ai-error"
            );
        } finally {
            input.disabled = false;
            sendButton.disabled = false;
            sendButton.textContent = "Send";
            input.focus();
        }
    });
});
