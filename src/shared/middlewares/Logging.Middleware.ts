import { Request, Response, NextFunction } from "express";

export const loggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
    console.log(`${res.statusCode} - [${req.method}] ${req.originalUrl || req.url} ${new Date().toLocaleString()}`);
    next();
};
