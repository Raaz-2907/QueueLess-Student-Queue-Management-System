require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const bcrypt = require("bcrypt");
const session = require("express-session");
const { runAgent } = require("./agent");

const app = express();

// Middleware
app.use(express.json());

app.use(
  session({
    name: "queueless.sid",
    secret:
      process.env.SESSION_SECRET ||
      "dev-only-change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 2 * 60 * 60 * 1000
    }
  })
);

// Serve frontend files from the public folder
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Allowed departments
const allowedServices = [
  "Student Services",
  "Accounts",
  "Examination Cell",
  "Library",
  "Administration",
  "IT Support"
];

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 4000),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    minVersion: "TLSv1.2"
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Helper: check whether a user is logged in
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in"
    });
  }

  next();
}

// Helper: check whether a student is logged in
function requireStudent(req, res, next) {
  if (
    !req.session.user ||
    req.session.user.role !== "student"
  ) {
    return res.status(401).json({
      error: "Please log in as a student"
    });
  }

  next();
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      message: "Backend and MySQL connected!"
    });
  } catch (error) {
    console.error("Database health error:", error);

    return res.status(500).json({
      error: "Database connection failed"
    });
  }
});

// Get all queue tokens
// Used by the student and staff dashboards
app.get("/api/queue", requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         id,
         student_name,
         service_type,
         status,
         created_at
       FROM queue_tokens
       ORDER BY id ASC`
    );

    return res.json(rows);
  } catch (error) {
    console.error("Queue loading error:", error);

    return res.status(500).json({
      error: "Could not load queue"
    });
  }
});

// Create a new student token
app.post("/api/queue", requireStudent, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const studentName = req.session.user.fullName;

    const serviceType = String(
      req.body?.serviceType || ""
    ).trim();

    if (!allowedServices.includes(serviceType)) {
      return res.status(400).json({
        error: "Invalid service type"
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO queue_tokens
       (user_id, student_name, service_type)
       VALUES (?, ?, ?)`,
      [userId, studentName, serviceType]
    );

    return res.status(201).json({
      message: "Token generated successfully",
      tokenNumber: result.insertId,
      studentName,
      serviceType,
      status: "Waiting"
    });
  } catch (error) {
    console.error("Token creation error:", error);

    return res.status(500).json({
      error: "Could not generate token"
    });
  }
});

// Cancel a waiting token belonging to the logged-in student
app.put(
  "/api/queue/:id/cancel",
  requireStudent,
  async (req, res) => {
    try {
      const tokenId = Number(req.params.id);
      const userId = req.session.user.id;

      if (!Number.isInteger(tokenId) || tokenId < 1) {
        return res.status(400).json({
          error: "Invalid token number"
        });
      }

      const [result] = await pool.execute(
        `UPDATE queue_tokens
         SET status = 'Cancelled'
         WHERE id = ?
           AND user_id = ?
           AND status = 'Waiting'`,
        [tokenId, userId]
      );

      if (result.affectedRows === 0) {
        return res.status(400).json({
          error:
            "Token not found, not yours, or no longer waiting"
        });
      }

      return res.json({
        message: "Token cancelled successfully",
        tokenNumber: tokenId,
        status: "Cancelled"
      });
    } catch (error) {
      console.error("Token cancellation error:", error);

      return res.status(500).json({
        error: "Could not cancel token"
      });
    }
  }
);

// Staff: call the next waiting token in a department
app.put("/api/queue/next", requireLogin, async (req, res) => {
  const department = String(
    req.body?.department || req.query.department || ""
  ).trim();

  if (!allowedServices.includes(department)) {
    return res.status(400).json({
      message: "Please select a valid department."
    });
  }

  let connection;
  let transactionStarted = false;

  try {
    connection = await pool.getConnection();

    await connection.beginTransaction();
    transactionStarted = true;

    const [waitingTokens] = await connection.execute(
      `SELECT id
       FROM queue_tokens
       WHERE service_type = ?
         AND status = 'Waiting'
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE`,
      [department]
    );

    // Leave the current serving token unchanged if nobody is waiting
    if (waitingTokens.length === 0) {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        message: `No students are waiting in ${department}.`
      });
    }

    const nextId = waitingTokens[0].id;

    // Complete the previous serving token in this department
    await connection.execute(
      `UPDATE queue_tokens
       SET status = 'Completed'
       WHERE service_type = ?
         AND status = 'Serving'`,
      [department]
    );

    const [updateResult] = await connection.execute(
      `UPDATE queue_tokens
       SET status = 'Serving'
       WHERE id = ?
         AND service_type = ?
         AND status = 'Waiting'`,
      [nextId, department]
    );

    if (updateResult.affectedRows !== 1) {
      throw new Error(
        `Token ${nextId} could not be changed to Serving.`
      );
    }

    await connection.commit();
    transactionStarted = false;

    console.log(
      `Department: ${department}; token ID ${nextId} is Serving`
    );

    return res.json({
      message:
        `Token ${nextId} is now being served in ${department}.`,
      tokenNumber: nextId,
      department,
      status: "Serving"
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback().catch((rollbackError) => {
        console.error("Rollback error:", rollbackError);
      });
    }

    console.error("Call Next error:", error);

    return res.status(500).json({
      message: "Failed to call the next student.",
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Register a new student account
app.post("/api/register", async (req, res) => {
  try {
    const fullName = String(
      req.body?.fullName || ""
    ).trim();

    const email = String(
      req.body?.email || ""
    ).trim().toLowerCase();

    const password = String(
      req.body?.password || ""
    );

    if (fullName.length < 2 || fullName.length > 100) {
      return res.status(400).json({
        error: "Name must be between 2 and 100 characters"
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 255
    ) {
      return res.status(400).json({
        error: "Enter a valid email address"
      });
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters and no more than 72 bytes"
      });
    }

    const [existing] = await pool.execute(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: "An account with this email already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.execute(
      `INSERT INTO users
       (full_name, email, password_hash, role)
       VALUES (?, ?, ?, 'student')`,
      [fullName, email, passwordHash]
    );

    return res.status(201).json({
      message: "Registration successful! Please log in."
    });
  } catch (error) {
    console.error("Registration error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "An account with this email already exists"
      });
    }

    return res.status(500).json({
      error: "Registration failed. Please try again."
    });
  }
});

// Log in
app.post("/api/login", async (req, res) => {
  try {
    const email = String(
      req.body?.email || ""
    ).trim().toLowerCase();

    const password = String(
      req.body?.password || ""
    );

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required"
      });
    }

    const [rows] = await pool.execute(
      `SELECT
         id,
         full_name,
         email,
         password_hash,
         role
       FROM users
       WHERE email = ?`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const user = rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error("Session error:", error);

        return res.status(500).json({
          error: "Could not start your session"
        });
      }

      req.session.user = {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role
      };

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError);

          return res.status(500).json({
            error: "Could not save your session"
          });
        }

        return res.json({
          message: "Login successful",
          redirect:
            user.role === "staff"
              ? "/staff.html"
              : "/dashboard.html"
        });
      });
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Login failed. Please try again."
    });
  }
});

// Get tokens belonging to the logged-in student
app.get("/api/my-queue", requireStudent, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.execute(
      `SELECT
         id,
         student_name,
         service_type,
         status,
         created_at
       FROM queue_tokens
       WHERE user_id = ?
       ORDER BY id ASC`,
      [userId]
    );

    return res.json(rows);
  } catch (error) {
    console.error("My queue loading error:", error);

    return res.status(500).json({
      error: "Could not load your queue"
    });
  }
});

// Get the current logged-in user's details
app.get("/api/me", requireLogin, (req, res) => {
  return res.json({
    user: req.session.user
  });
});

// Log out
app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout error:", error);

      return res.status(500).json({
        error: "Could not log out"
      });
    }

    res.clearCookie("queueless.sid");

    return res.json({
      message: "Logged out successfully"
    });
  });
});

// Start server
const PORT = process.env.PORT || 3000;

// ======================================
// QUEUELESS AI STUDENT ASSISTANT
// ======================================

app.post("/api/ai/chat", requireStudent, async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message || message.length > 1000) {
      return res.status(400).json({
        error: "Message must contain 1 to 1000 characters."
      });
    }

    const reply = await runAgent({
      pool,
      userId: req.session.user.id,
      message,
      allowedServices
    });

    return res.json({ reply });

  } catch (error) {
    console.error("QueueLess AI agent error:", error.message);

    return res.status(500).json({
      error: "AI assistant could not process your message."
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(
    `Backend running at http://localhost:${PORT}`
  );
});

// Graceful shutdown
process.on("SIGINT", () => {
  server.close(async () => {
    try {
      await pool.end();
      console.log("Server and database pool closed.");
    } catch (error) {
      console.error("Shutdown error:", error);
    }

    process.exit(0);
  });
});