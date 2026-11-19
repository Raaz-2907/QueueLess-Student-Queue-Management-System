const OLLAMA_URL = process.env.OLLAMA_URL || "https://ollama.com/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

// Tool definitions that Qwen can select.
const tools = [
  {
    type: "function",
    function: {
      name: "get_my_tokens",
      description: "Get the logged-in student's recent queue tokens.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_queue_status",
      description: "Check the status of one of the logged-in student's tokens.",
      parameters: {
        type: "object",
        properties: {
          tokenId: {
            type: "integer",
            description: "The numeric token ID."
          }
        },
        required: ["tokenId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_people_ahead",
      description: "Count waiting students ahead of the student's token in the same department.",
      parameters: {
        type: "object",
        properties: {
          tokenId: {
            type: "integer",
            description: "The numeric token ID."
          }
        },
        required: ["tokenId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_waiting_time",
      description: "Estimate waiting time for the student's waiting token. Uses five minutes per person ahead.",
      parameters: {
        type: "object",
        properties: {
          tokenId: {
            type: "integer",
            description: "The numeric token ID."
          }
        },
        required: ["tokenId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_department_queue",
      description: "Get aggregate queue counts for a department without revealing student information.",
      parameters: {
        type: "object",
        properties: {
          department: {
            type: "string",
            enum: [
              "Student Services",
              "Accounts",
              "Examination Cell",
              "Library",
              "Administration",
              "IT Support"
            ]
          }
        },
        required: ["department"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_departments",
      description: "List all available QueueLess departments.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }
];

function validTokenId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Always verify that a token belongs to the logged-in student.
async function getOwnedToken(pool, userId, tokenId) {
  const id = validTokenId(tokenId);
  if (!id) {
    return { error: "Please provide a valid numeric token ID." };
  }

  const [rows] = await pool.execute(
    `SELECT id, service_type, status, created_at
     FROM queue_tokens
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [id, userId]
  );

  if (rows.length === 0) {
    return { error: "Token not found in your account." };
  }

  return rows[0];
}

// Execute only the tools explicitly approved above.
async function executeTool(name, args, context) {
  const { pool, userId, allowedServices } = context;

  switch (name) {
    case "get_my_tokens": {
      const [rows] = await pool.execute(
        `SELECT id, service_type, status, created_at
         FROM queue_tokens
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 10`,
        [userId]
      );

      return { tokens: rows };
    }

    case "get_queue_status": {
      const token = await getOwnedToken(
        pool,
        userId,
        args.tokenId
      );

      if (token.error) return token;

      return {
        tokenId: token.id,
        department: token.service_type,
        status: token.status,
        createdAt: token.created_at
      };
    }

    case "get_people_ahead": {
      const token = await getOwnedToken(
        pool,
        userId,
        args.tokenId
      );

      if (token.error) return token;

      if (token.status !== "Waiting") {
        return {
          tokenId: token.id,
          status: token.status,
          peopleAhead: 0,
          explanation: "People ahead are counted only while your token is Waiting."
        };
      }

      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS peopleAhead
         FROM queue_tokens
         WHERE service_type = ?
           AND status = 'Waiting'
           AND id < ?`,
        [token.service_type, token.id]
      );

      return {
        tokenId: token.id,
        department: token.service_type,
        peopleAhead: Number(rows[0].peopleAhead)
      };
    }

    case "get_waiting_time": {
      const token = await getOwnedToken(
        pool,
        userId,
        args.tokenId
      );

      if (token.error) return token;

      if (token.status !== "Waiting") {
        return {
          tokenId: token.id,
          status: token.status,
          estimatedMinutes: 0,
          explanation: "The waiting-time estimate applies only to Waiting tokens."
        };
      }

      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS peopleAhead
         FROM queue_tokens
         WHERE service_type = ?
           AND status = 'Waiting'
           AND id < ?`,
        [token.service_type, token.id]
      );

      const peopleAhead = Number(rows[0].peopleAhead);

      return {
        tokenId: token.id,
        department: token.service_type,
        peopleAhead,
        minutesPerPerson: 5,
        estimatedMinutes: peopleAhead * 5,
        note: "This is an estimate, not a guaranteed service time."
      };
    }

    case "get_department_queue": {
      const department = args.department;

      if (!allowedServices.includes(department)) {
        return { error: "Please select a valid QueueLess department." };
      }

      const [rows] = await pool.execute(
        `SELECT
           COUNT(*) AS totalTokens,
           SUM(status = 'Waiting') AS waiting,
           SUM(status = 'Serving') AS serving,
           SUM(status = 'Completed') AS completed,
           SUM(status = 'Cancelled') AS cancelled
         FROM queue_tokens
         WHERE service_type = ?`,
        [department]
      );

      const row = rows[0];

      return {
        department,
        totalTokens: Number(row.totalTokens || 0),
        waiting: Number(row.waiting || 0),
        serving: Number(row.serving || 0),
        completed: Number(row.completed || 0),
        cancelled: Number(row.cancelled || 0)
      };
    }

    case "get_departments":
      return { departments: allowedServices };

    default:
      return { error: "This tool is not available." };
  }
}

async function runAgent({ pool, userId, message, allowedServices }) {
  const context = { pool, userId, allowedServices };

  // Handle token history questions before general queue questions.
  const historyQuestion =
    /\b(history|previous tokens|recent tokens|past tokens|token records)\b/i.test(message);

  if (historyQuestion) {
    const historyResult = await executeTool("get_my_tokens", {}, context);
    const tokens = historyResult.tokens || [];

    if (tokens.length === 0) {
      return "You have no previous queue tokens in your account.";
    }

    const prefixes = {
      "Student Services": "A",
      "Accounts": "B",
      "Examination Cell": "C",
      "Library": "D",
      "Administration": "E",
      "IT Support": "F"
    };

    return [
      "Here is your recent token history:",
      "",
      ...tokens.map((token, index) => {
        const prefix = prefixes[token.service_type] || "";
        const tokenLabel = prefix + String(token.id).padStart(3, "0");
        const date = token.created_at
          ? new Date(token.created_at).toLocaleDateString("en-IN")
          : "Date unavailable";

        return [
          `${index + 1}. Token: ${tokenLabel}`,
          `   Department: ${token.service_type}`,
          `   Date: ${date}`,
          `   Status: ${token.status}`
        ].join("\n");
      })
    ].join("\n");
  }

  // Handle department-level queue questions separately.
  const requestedDepartment = allowedServices.find(department =>
    message.toLowerCase().includes(department.toLowerCase())
  );

  const asksOwnQueue =
    /\b(my|mine|my token|my tokens)\b/i.test(message);

  const asksDepartmentQueue =
    !asksOwnQueue && (
      /\b(overall|department|all students|entire|current queue|queue status in|queue status for)\b/i.test(message) ||
      (requestedDepartment &&
        /\b(queue|waiting|serving|status|tokens)\b/i.test(message))
    );

  if (asksDepartmentQueue) {
    if (!requestedDepartment) {
      return "Please specify which department you want to check.";
    }

    const result = await executeTool(
      "get_department_queue",
      { department: requestedDepartment },
      context
    );

    if (result.error) return result.error;

    return [
      "Current queue summary:",
      "",
      "Department: " + result.department,
      "Total tokens: " + result.totalTokens,
      "Waiting: " + result.waiting,
      "Currently serving: " + result.serving,
      "Completed: " + result.completed,
      "Cancelled: " + result.cancelled
    ].join("\n");
  }

  // Automatically select database tools for student queue questions.
  const queueQuestion =
    /\b(token|queue|status|people ahead|waiting time|wait time|position|how long)\b/i.test(message);

  if (queueQuestion) {
    const tokenResult = await executeTool("get_my_tokens", {}, context);
    const tokens = tokenResult.tokens || [];

    if (tokens.length === 0) {
      return "You currently have no queue tokens in your account.";
    }

    // Prefer the student's newest active token.
    const token =
      tokens.find(t => t.status === "Waiting" || t.status === "Serving") ||
      tokens[0];

    const statusResult = await executeTool(
      "get_queue_status",
      { tokenId: token.id },
      context
    );

    if (statusResult.error) return statusResult.error;

    const aheadResult = await executeTool(
      "get_people_ahead",
      { tokenId: token.id },
      context
    );

    const waitResult = await executeTool(
      "get_waiting_time",
      { tokenId: token.id },
      context
    );

    const prefixes = {
      "Student Services": "A",
      "Accounts": "B",
      "Examination Cell": "C",
      "Library": "D",
      "Administration": "E",
      "IT Support": "F"
    };

    const prefix = prefixes[statusResult.department] || "";
    const tokenLabel = prefix + String(statusResult.tokenId).padStart(3, "0");

    return [
      "Here is your latest queue token information:",
      "",
      "Token: " + tokenLabel,
      "Department: " + statusResult.department,
      "Status: " + statusResult.status,
      "People ahead: " + (aheadResult.peopleAhead ?? 0),
      "Estimated waiting time: " + (waitResult.estimatedMinutes ?? 0) + " minutes",
      "",
      "Note: Waiting time is an estimate, not a guaranteed service time."
    ].join("\\n");
  }
  const messages = [
    {
      role: "system",
      content: `
You are QueueLess AI, an assistant for a student queue management system.

You can use the provided tools to retrieve real queue information.
Use tools whenever a question requires actual token, status, queue position,
waiting time, or department information.

Important rules:
- Never invent token numbers, queue positions, statuses, or waiting times.
- Only discuss information returned by the tools.
- Students can access only their own tokens.
- If a token is not found in the student's account, explain that clearly.
- Never claim that you generated or cancelled a token.
- Never claim that you changed database records.
- Waiting time is an estimate of five minutes per person ahead.
- People ahead are waiting tokens in the same department with a lower ID.
- Be polite, clear, and concise.
- If you do not have enough information, ask the student for clarification.
      `.trim()
    },
    {
      role: "user",
      content: message
    }
  ];

  // Allow a maximum of four tool-processing rounds.
  for (let round = 0; round < 4; round++) {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OLLAMA_API_KEY
          ? { Authorization: `Bearer ${OLLAMA_API_KEY}` }
          : {})
      },


      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        stream: false
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Ollama request failed (${response.status}): ${details.slice(0, 300)}`
      );
    }

    const data = await response.json();
    const assistantMessage = data.message;

    if (!assistantMessage) {
      throw new Error("Ollama returned an empty response.");
    }

    const toolCalls = assistantMessage.tool_calls || [];

    if (toolCalls.length === 0) {
      const reply = String(assistantMessage.content || "").trim();

      return reply || "I could not generate an answer. Please try again.";
    }

    messages.push(assistantMessage);

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = call.function?.arguments || {};

      let result;

      try {
        result = await executeTool(name, args, context);
      } catch (error) {
        console.error("QueueLess tool error:", error.message);
        result = { error: "The requested queue information could not be retrieved." };
      }
      messages.push({
        role: "tool",
        tool_name: name,
        content: JSON.stringify(result)
      });

    }
  }

  return "I could not complete that request. Please try asking in a simpler way.";
}

module.exports = { runAgent };
