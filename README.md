# 💬 ChatSphere — Real-Time Chat Application

A production-style real-time chat application built with **Node.js, Express, Socket.IO and MongoDB**.
Supports 1-to-1 chat, group chat, JWT auth, online/offline presence, typing indicators,
read receipts, and real-time notifications.

---

## 1. Tech Stack

**Backend:** Node.js, Express.js, Socket.IO, MongoDB, Mongoose, JWT, bcryptjs, Helmet, express-rate-limit, CORS
**Frontend:** HTML5, CSS3, vanilla JavaScript, Bootstrap 5, Socket.IO client

---

## 2. Project Structure

```
chat-application/
├── server.js                # App entry point — wires everything together
├── config/db.js             # MongoDB connection
├── models/                  # Mongoose schemas
├── controllers/             # Business logic for each REST resource
├── routes/                  # Express route definitions
├── middleware/               # JWT auth guard + centralized error handler
├── socket/socketHandler.js  # All Socket.IO real-time logic
├── utils/generateToken.js   # JWT signing helper
└── public/                  # Static frontend (login, register, chat UI)
```

---

## 3. Setup — Run It Locally

### Step 1 — Install prerequisites
- [Node.js](https://nodejs.org) v18+
- MongoDB — either install locally, or create a free cluster on
  [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (recommended, 2 minutes to set up)

### Step 2 — Install dependencies
```bash
cd chat-application
npm install
```

### Step 3 — Configure environment variables
Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```
```
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/chat-app     # or your Atlas connection string
JWT_SECRET=some_long_random_string
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:5000
```

### Step 4 — Run the server
```bash
npm run dev      # with nodemon (auto-restart)
# or
npm start
```

### Step 5 — Open the app
Go to `http://localhost:5000` in **two different browser windows / incognito tabs**
(or two different browsers), register two different users, and start chatting in
real time between them.

---

## 4. Database Design & Relationships

- **User** — a person who can log in. Standalone collection.
- **Conversation** — represents either a 1-to-1 chat or a group. Holds an array of
  `participants` (ref → User). For groups, also stores `groupName`, `groupAdmin`
  and `groupAvatar`. `lastMessage` is a ref → Message, used to render chat-list previews
  without querying the Message collection separately.
- **Message** — belongs to exactly one `conversationId` (ref → Conversation) and has a
  `sender` (ref → User). `replyTo` self-references another Message for reply threads.
  `readBy` is an array of User refs, used to compute read receipts.
- **Notification** — created when a message is sent to a user who is **offline** at that
  moment (see socket logic), so they see what they missed when they return. `recipient`
  and `sender` both ref → User.

**Relationship summary:** `User 1—N Conversation` (via participants array, many-to-many
in practice) → `Conversation 1—N Message` → `Message` optionally self-references via
`replyTo`, and fans out to `Notification` for offline recipients.

---

## 5. REST API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | No | Create account, returns user + JWT |
| POST | `/api/auth/login` | No | Login, returns user + JWT, sets isOnline |
| GET | `/api/auth/me` | Yes | Get currently logged-in user |
| POST | `/api/auth/logout` | Yes | Sets isOnline false, updates lastSeen |
| GET | `/api/users?search=` | Yes | Search users by name/username |
| GET | `/api/users/:id` | Yes | Get a single user's public profile |
| PUT | `/api/users/profile` | Yes | Update name/avatar |
| PUT | `/api/users/change-password` | Yes | Change password |
| GET | `/api/conversations` | Yes | List all of my conversations, newest first |
| POST | `/api/conversations` | Yes | Create 1-to-1 (`{type:'one-to-one', userId}`) or group (`{type:'group', groupName, members:[]}`) |
| PUT | `/api/conversations/:id/add-member` | Yes | Admin adds a member to a group |
| PUT | `/api/conversations/:id/remove-member` | Yes | Admin removes a member |
| PUT | `/api/conversations/:id/leave` | Yes | Leave a group |
| GET | `/api/messages/:conversationId?page=&limit=` | Yes | Paginated message history |
| POST | `/api/messages` | Yes | Send message via REST (fallback; normal flow uses sockets) |
| PUT | `/api/messages/:id` | Yes | Edit your own message |
| DELETE | `/api/messages/:id` | Yes | Soft-delete your own message |
| GET | `/api/notifications` | Yes | List my notifications |
| PUT | `/api/notifications/:id/read` | Yes | Mark one notification as read |

All authenticated routes expect: `Authorization: Bearer <JWT>`

---

## 6. Socket.IO Architecture

```
Client (socket.io-client)
   │  connects with:  io(URL, { auth: { token: JWT } })
   ▼
Socket.IO server — io.use() middleware
   │  verifies JWT, attaches socket.user
   ▼
"connection" event
   │  → marks user online, auto-joins all their conversation rooms
   │  → broadcasts "user_online" to everyone else
   ▼
Client emits events:
   join_room / leave_room   → manually join/leave a specific conversation room
   send_message             → server saves to MongoDB, emits "receive_message" to the room,
                               marks "delivered" for online recipients, creates a
                               Notification + emits "new_notification" for offline ones
   message_read             → server marks messages read in DB, emits "message_read" to room
   typing / stop_typing     → relayed directly to the other room members

Server emits back:
   receive_message, message_delivered, message_read,
   typing, stop_typing, user_online, user_offline, new_notification
   ▼
"disconnect" event
   │  → removes this socket; if it was the user's last open tab,
   │    marks fully offline + records lastSeen + broadcasts "user_offline"
```

Each user also auto-joins a **personal room named after their own userId**, so the
server can push a notification straight to them (`io.to(userId).emit(...)`) even if
they don't currently have the relevant conversation open.

---

## 7. Notes on File/Image Upload (not enabled by default)

The spec mentions optional image/file messages. **Do not store binary files inside
MongoDB** — it bloats the database and kills read performance. If you add this feature:

1. Upload the file from the browser to a dedicated storage service — **Amazon S3**,
   **Cloudinary**, or **Firebase Storage** are the standard choices.
2. The storage service returns a public (or signed) URL.
3. Save only that **URL string** in `Message.fileUrl`, with `messageType: 'image'` or `'file'`.
4. On the frontend, render an `<img>` or a download link using that URL.

This keeps MongoDB fast and lets you serve files from a CDN instead of your app server.

---

## 8. Deployment Notes

- **Backend:** Render, Railway, or a VPS (with PM2 to keep the Node process alive).
- **Database:** MongoDB Atlas free tier is enough for a demo/resume project.
- **Socket.IO in production:** if you ever scale to multiple server instances, add the
  `socket.io-redis` (or `@socket.io/redis-adapter`) adapter so real-time events are
  broadcast across all instances, not just the one that received them.
- Set `CLIENT_URL` and `MONGO_URI` as environment variables on your host — never commit
  `.env` to git (already covered by `.gitignore`).

---

## 9. Resume / Interview Talking Points

- Implemented JWT-based stateless auth with bcrypt password hashing and rate-limited
  auth endpoints (brute-force protection via `express-rate-limit`).
- Built a real-time layer on Socket.IO with **socket-level JWT authentication**
  (`io.use` middleware), presence tracking (online/offline/last-seen) using an
  in-memory map of active socket connections per user, typing indicators, and a
  three-state message delivery pipeline (sent → delivered → read).
- Designed a MongoDB schema that supports both 1-to-1 and group conversations through
  a single polymorphic `Conversation` model, with indexed queries for fast chat-list
  and message-history loading, plus pagination for infinite-scroll history.
- Handled the offline-user edge case with a persistent `Notification` collection so
  no real-time event is silently lost.
