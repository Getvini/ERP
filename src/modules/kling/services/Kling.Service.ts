import axios from "axios";

export interface KlingMultiPromptItem {
    index: number;
    prompt: string;
    duration: string;
}

export interface KlingCreateVideoDto {
    modelName: string;
    imageUrl: string;
    imageTailUrl?: string;

    prompt: string;
    negativePrompt?: string;

    duration?: string;
    mode?: "std" | "pro" | "4k";
    sound?: "on" | "off";
    externalTaskId?: string;
    callbackUrl?: string;

    multiShot?: boolean;
    shotType?: "customize" | "intelligence";
    multiPrompt?: KlingMultiPromptItem[];
}

export interface KlingVideo {
    id: string;
    url: string;
    duration: string;
}

export interface KlingTaskResult {
    task_id: string;
    task_status: "submitted" | "processing" | "succeed" | "failed";
    task_result?: { videos?: KlingVideo[] };
    task_status_msg?: string;
    created_at: number;
    updated_at: number;
}

export interface KlingApiResponse {
    code: number;
    message: string;
    request_id: string;
    data: KlingTaskResult;
}

export interface KlingCreateMotionControlDto {
    modelName: string;
    imageUrl: string;
    videoUrl: string;
    prompt?: string;
    keepOriginalSound?: "yes" | "no";
    characterOrientation: "image" | "video";
    mode: "std" | "pro";
    externalTaskId?: string;
}

export interface KlingCreateElementDto {
    elementName: string;
    elementDescription: string;
    referenceType: "image_refer" | "video_refer";
    frontalImageUrl?: string;
    referImageUrls?: string[];
    videoUrl?: string;
    elementVoiceId?: string;
    externalTaskId?: string;
    callbackUrl?: string;
}

export interface KlingElementTaskResult {
    task_id: string;
    task_status: "submitted" | "processing" | "succeed" | "failed";
    task_status_msg?: string;
    created_at: number;
    updated_at: number;
}

export interface KlingElementApiResponse {
    code: number;
    message: string;
    request_id: string;
    data: KlingElementTaskResult;
}

export interface KlingElementResult {
    element_id: number;
    element_name: string;
    element_description: string;
    reference_type: string;
    element_image_list?: any;
    element_video_list?: any;
    element_voice_info?: any;
}

export interface KlingElementQueryResult {
    task_id: string;
    task_status: "submitted" | "processing" | "succeed" | "failed";
    task_status_msg?: string;
    created_at: number;
    updated_at: number;
    task_result?: { elements: KlingElementResult[] };
}

export interface KlingElementQueryApiResponse {
    code: number;
    message: string;
    request_id: string;
    data: KlingElementQueryResult;
}

export class KlingService {
    private readonly baseUrl = "https://api-singapore.klingai.com";
    private readonly logPrefix = "[Kling]";

    private get headers() {
        const apiKey = process.env.KLING_API_KEY;
        if (!apiKey) {
            throw new Error("Thiếu cấu hình KLING_API_KEY trong .env");
        }
        return {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        };
    }

    async createImageToVideo(dto: KlingCreateVideoDto): Promise<KlingApiResponse> {
        const payload: Record<string, any> = {
            model_name: dto.modelName,
            image: dto.imageUrl,
            duration: dto.duration || "5",
            mode: dto.mode || "std",
            sound: dto.sound || "off",
            negative_prompt: dto.negativePrompt || "",
            callback_url: dto.callbackUrl || "",
            external_task_id: dto.externalTaskId || "",
        };

        if (dto.imageTailUrl) {
            payload.image_tail = dto.imageTailUrl;
        }

        if (dto.multiShot) {
            payload.multi_shot = true;
            payload.shot_type = dto.shotType || "customize";

            if (dto.shotType === "intelligence") {
                payload.prompt = dto.prompt;
            } else {
                payload.multi_prompt = (dto.multiPrompt ?? []).map((item) => ({
                    index: item.index,
                    prompt: item.prompt,
                    duration: item.duration,
                }));
            }
        } else {
            payload.multi_shot = false;
            payload.prompt = dto.prompt;
        }

        console.log(`${this.logPrefix} createImageToVideo payload: ${JSON.stringify(payload)}`);

        const response = await axios.post<KlingApiResponse>(
            `${this.baseUrl}/v1/videos/image2video`,
            payload,
            { headers: this.headers }
        );

        return response.data;
    }

    async getTaskStatus(taskId: string): Promise<KlingApiResponse> {
        try {
            const response = await axios.get<KlingApiResponse>(
                `${this.baseUrl}/v1/videos/image2video/${taskId}`,
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} getTaskStatus error - HTTP: ${err.response?.status}, ` +
                `ServiceCode: ${err.response?.data?.code}, Msg: ${err.response?.data?.message}`
            );
            throw err;
        }
    }

    async createMotionControl(dto: KlingCreateMotionControlDto): Promise<KlingApiResponse> {
        const payload: any = {
            model_name: dto.modelName,
            image_url: dto.imageUrl,
            video_url: dto.videoUrl,
            prompt: dto.prompt || "",
            keep_original_sound: dto.keepOriginalSound || "yes",
            character_orientation: dto.characterOrientation,
            mode: dto.mode || "pro",
            external_task_id: dto.externalTaskId || "",
        };

        console.log(`${this.logPrefix} MotionControl creating task: ${JSON.stringify(payload)}`);

        try {
            const response = await axios.post<KlingApiResponse>(
                `${this.baseUrl}/v1/videos/motion-control`,
                payload,
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} MotionControl FAILED - status: ${err.response?.status}, ` +
                `data: ${JSON.stringify(err.response?.data)}`
            );
            throw err;
        }
    }

    async getMotionControlTaskStatus(taskId: string): Promise<KlingApiResponse> {
        try {
            const response = await axios.get<KlingApiResponse>(
                `${this.baseUrl}/v1/videos/motion-control/${taskId}`,
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} getMotionControlTaskStatus error - status: ${err.response?.status}, ` +
                `data: ${JSON.stringify(err.response?.data)}`
            );
            throw err;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async pollUntilDone(
        taskId: string,
        intervalMs = 30000,
        maxAttempts = 40
    ): Promise<KlingTaskResult> {
        console.log(`${this.logPrefix} Start polling taskId: ${taskId}`);
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await this.sleep(intervalMs);

            try {
                const res = await this.getTaskStatus(taskId);
                const task = res.data;
                consecutiveErrors = 0;

                console.log(`${this.logPrefix} Attempt ${attempt}/${maxAttempts} - status: ${task.task_status}`);

                if (task.task_status === "succeed") {
                    console.log(`${this.logPrefix} Task ${taskId} SUCCEED`);
                    return task;
                }

                if (task.task_status === "failed") {
                    console.error(`${this.logPrefix} Task ${taskId} FAILED: ${task.task_status_msg}`);
                    throw new Error(`Kling task failed: ${task.task_status_msg}`);
                }
            } catch (err: any) {
                if (err.message?.startsWith("Kling task failed:")) throw err;

                const httpStatus = err.response?.status;
                const serviceCode = err.response?.data?.code;

                if (httpStatus === 401) {
                    if (serviceCode === 1003) {
                        console.warn(`${this.logPrefix} Attempt ${attempt} - 401/1003 (clock skew), skipping...`);
                        continue;
                    }
                    if (serviceCode === 1004) {
                        console.warn(`${this.logPrefix} Attempt ${attempt} - 401/1004 (token expired), skipping...`);
                        continue;
                    }
                    if (serviceCode === 1000 || serviceCode === 1002) {
                        throw new Error(`Kling auth failed (${serviceCode}): kiểm tra lại KLING_API_KEY`);
                    }
                    console.warn(`${this.logPrefix} Attempt ${attempt} - 401 (serviceCode: ${serviceCode}), skipping...`);
                    continue;
                }

                consecutiveErrors++;
                console.warn(
                    `${this.logPrefix} Attempt ${attempt} non-auth error (${consecutiveErrors}/${maxConsecutiveErrors}): ${err.message}`
                );
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    throw new Error(
                        `Kling polling aborted after ${maxConsecutiveErrors} consecutive errors: ${err.message}`
                    );
                }
            }
        }

        throw new Error(`Kling task ${taskId} timeout sau ${maxAttempts} lần poll`);
    }

    async pollMotionControlUntilDone(
        taskId: string,
        intervalMs = 30000,
        maxAttempts = 40
    ): Promise<KlingTaskResult> {
        console.log(`${this.logPrefix} MotionControl start polling taskId: ${taskId}`);
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await this.sleep(intervalMs);

            try {
                const res = await this.getMotionControlTaskStatus(taskId);
                const task = res.data;
                consecutiveErrors = 0;

                console.log(`${this.logPrefix} MotionControl attempt ${attempt}/${maxAttempts} - status: ${task.task_status}`);

                if (task.task_status === "succeed") return task;

                if (task.task_status === "failed") {
                    throw new Error(`Kling motion control task failed: ${task.task_status_msg}`);
                }
            } catch (err: any) {
                if (err.message?.startsWith("Kling motion control task failed:")) throw err;

                consecutiveErrors++;
                console.warn(
                    `${this.logPrefix} MotionControl attempt ${attempt} error (${consecutiveErrors}/${maxConsecutiveErrors}): ${err.message}`
                );

                if (consecutiveErrors >= maxConsecutiveErrors) {
                    throw new Error(
                        `Kling MotionControl polling aborted after ${maxConsecutiveErrors} consecutive errors: ${err.message}`
                    );
                }
            }
        }

        throw new Error(`Kling motion control task ${taskId} timeout`);
    }

    async createElement(dto: KlingCreateElementDto): Promise<KlingElementApiResponse> {
        const payload: Record<string, any> = {
            element_name: dto.elementName,
            element_description: dto.elementDescription,
            reference_type: dto.referenceType,
            callback_url: dto.callbackUrl || "",
            external_task_id: dto.externalTaskId || "",
        };

        if (dto.referenceType === "image_refer") {
            payload.element_image_list = {
                frontal_image: dto.frontalImageUrl,
                refer_images: (dto.referImageUrls ?? []).map((url) => ({ image_url: url })),
            };
            if (dto.elementVoiceId) payload.element_voice_id = dto.elementVoiceId;
        } else {
            payload.element_video_list = {
                refer_videos: dto.videoUrl ? [{ video_url: dto.videoUrl }] : [],
            };
        }

        console.log(`${this.logPrefix} createElement payload: ${JSON.stringify(payload)}`);

        try {
            const response = await axios.post<KlingElementApiResponse>(
                `${this.baseUrl}/v1/general/advanced-custom-elements/`,
                payload,
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} createElement FAILED - status: ${err.response?.status}, data: ${JSON.stringify(err.response?.data)}`
            );
            throw err;
        }
    }

    async getElementTaskStatus(taskId: string): Promise<KlingElementQueryApiResponse> {
        try {
            const response = await axios.get<KlingElementQueryApiResponse>(
                `${this.baseUrl}/v1/general/advanced-custom-elements/${taskId}`,
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} getElementTaskStatus error - status: ${err.response?.status}, data: ${JSON.stringify(err.response?.data)}`
            );
            throw err;
        }
    }

    async deleteElement(elementId: string): Promise<any> {
        try {
            const response = await axios.post(
                `${this.baseUrl}/v1/general/delete-advanced-elements`,
                { element_id: elementId },
                { headers: this.headers }
            );
            return response.data;
        } catch (err: any) {
            console.error(
                `${this.logPrefix} deleteElement error - status: ${err.response?.status}, data: ${JSON.stringify(err.response?.data)}`
            );
            throw err;
        }
    }

    async pollElementUntilDone(
        taskId: string,
        intervalMs = 5000,
        maxAttempts = 30
    ): Promise<KlingElementQueryResult> {
        console.log(`${this.logPrefix} Start polling element taskId: ${taskId}`);
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await this.sleep(intervalMs);

            try {
                const res = await this.getElementTaskStatus(taskId);
                const task = res.data;
                consecutiveErrors = 0;

                console.log(`${this.logPrefix} Element poll ${attempt}/${maxAttempts} - status: ${task.task_status}`);

                if (task.task_status === "succeed") return task;
                if (task.task_status === "failed") {
                    throw new Error(`Kling element task failed: ${task.task_status_msg}`);
                }
            } catch (err: any) {
                if (err.message?.startsWith("Kling element task failed:")) throw err;

                consecutiveErrors++;
                console.warn(
                    `${this.logPrefix} Element poll attempt ${attempt} error (${consecutiveErrors}/${maxConsecutiveErrors}): ${err.message}`
                );
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    throw new Error(
                        `Kling element polling aborted after ${maxConsecutiveErrors} consecutive errors: ${err.message}`
                    );
                }
            }
        }

        throw new Error(`Kling element task ${taskId} timeout sau ${maxAttempts} lần poll`);
    }
}
