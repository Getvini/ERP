import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server, Socket } from "socket.io";
import { AppDataSource } from "./data-source";
import { Accounts } from "./modules/account/entities/Account.entity";
import { ChatParticipants } from "./modules/chat-room/entities/ChatParticipant.entity";
import { ChatRoomService } from "./modules/chat-room/services/ChatRoom.Service";
import { XiangqiService } from "./modules/xiangqi/services/Xiangqi.Service";

interface AuthenticatedSocket extends Socket {
    user?: {
        accountId: string;
        userId?: string;
        username: string;
    };
}

const onlineUsers = new Map<string, Set<string>>();

function getOnlineUserIds() {
    return Array.from(onlineUsers.entries())
        .filter(([, socketIds]) => socketIds.size > 0)
        .map(([userId]) => userId);
}

function parseCookie(cookieString: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieString) return cookies;

    cookieString.split(";").forEach((cookie) => {
        const [key, ...valueParts] = cookie.split("=");
        cookies[key.trim()] = valueParts.join("=").trim();
    });

    return cookies;
}

function extractToken(socket: Socket) {
    const cookies = parseCookie(socket.request.headers.cookie || "");
    const authHeader = socket.request.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    return socket.handshake.auth?.token
        || socket.handshake.query?.token
        || bearerToken
        || cookies.accessToken;
}

export function initSocket(httpServer: HttpServer) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : [];

    const io = new Server(httpServer, {
        cors: {
            origin: (origin, callback) => {
                if (!origin) return callback(null, true);
                if (
                    allowedOrigins.includes(origin) ||
                    origin.endsWith(".vercel.app") ||
                    origin.endsWith(".onrender.com") ||
                    /^http:\/\/localhost:\d+$/.test(origin)
                ) {
                    callback(null, true);
                } else {
                    callback(new Error("Not allowed by CORS"));
                }
            },
            credentials: true
        }
    });

    void XiangqiService.init(io);

    io.use(async (socket: AuthenticatedSocket, next) => {
        try {
            const token = extractToken(socket);
            if (!token || typeof token !== "string") {
                return next(new Error("Authentication failed. No token provided."));
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET || "") as any;
            if (!decoded?.id || decoded.type !== "access") {
                return next(new Error("Authentication failed. Invalid token."));
            }

            const account = await AppDataSource.getRepository(Accounts).findOne({
                where: { id: decoded.id },
                relations: ["user"]
            });

            if (!account || !account.isActive) {
                return next(new Error("Authentication failed. Account not found."));
            }

            socket.user = {
                accountId: account.id,
                userId: account.user?.id || account.userId,
                username: account.username
            };

            next();
        } catch (error) {
            console.error("Socket authentication error:", error);
            next(new Error("Authentication failed."));
        }
    });

    io.on("connection", (socket: AuthenticatedSocket) => {
        const userId = socket.user?.userId;
        if (userId) {
            const socketIds = onlineUsers.get(userId) || new Set<string>();
            socketIds.add(socket.id);
            onlineUsers.set(userId, socketIds);
            io.emit("online_users", getOnlineUserIds());
        }

        console.log(`User connected to Socket.io: ${socket.user?.username} (${socket.id})`);

        void XiangqiService.attach(socket); // cờ tướng: ghép trận + ván đấu realtime

        socket.on("join_room", (roomId: string) => {
            socket.join(roomId);
        });

        socket.on("leave_room", (roomId: string) => {
            socket.leave(roomId);
        });

        socket.on("typing", (roomId: string) => {
            socket.to(roomId).emit("user_typing", {
                roomId,
                userId: socket.user?.userId,
                username: socket.user?.username
            });
        });

        socket.on("stop_typing", (roomId: string) => {
            socket.to(roomId).emit("user_stop_typing", {
                roomId,
                userId: socket.user?.userId
            });
        });

        socket.on("send_message", async (
            data: { roomId: string; content: string; attachments?: any[] },
            ack?: (response: { ok: boolean; message?: any; error?: string }) => void
        ) => {
            try {
                const { roomId, content, attachments } = data;
                const senderUserId = socket.user?.userId;
                if (!roomId || !content?.trim() || !senderUserId) {
                    ack?.({ ok: false, error: "Tin nhắn không hợp lệ" });
                    return;
                }

                const participantRepo = AppDataSource.getRepository(ChatParticipants);
                const allParticipants = await participantRepo.find({ where: { roomId } });
                const populatedMessage = await ChatRoomService.createMessage(roomId, senderUserId, content, attachments || []);

                if (populatedMessage) {
                    allParticipants.forEach((participant) => {
                        const socketIds = onlineUsers.get(participant.userId);
                        socketIds?.forEach((socketId) => {
                            io.to(socketId).emit("receive_message", populatedMessage);
                        });
                    });
                    ack?.({ ok: true, message: populatedMessage });
                }
            } catch (error: any) {
                console.error("Error in send_message socket event:", error);
                socket.emit("error", { message: "Không thể gửi tin nhắn" });
                ack?.({ ok: false, error: error.message || "Không thể gửi tin nhắn" });
            }
        });

        socket.on("disconnect", () => {
            if (userId) {
                const socketIds = onlineUsers.get(userId);
                socketIds?.delete(socket.id);
                if (!socketIds || socketIds.size === 0) {
                    onlineUsers.delete(userId);
                }
                io.emit("online_users", getOnlineUserIds());
            }
            console.log(`User disconnected from Socket.io: ${socket.user?.username} (${socket.id})`);
        });
    });

    return io;
}
