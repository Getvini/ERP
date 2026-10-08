export const nameRegex = /^[a-zA-ZÀ-ỹ0-9\s]+$/;
export const phoneRegex = /^\+?[0-9]{10,15}$/;
export const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const idCardRegex = /^([0-9]{9}|[0-9]{12})$/;

export const validateUserData = (data: any) => {
    // Validate User fields
    if (data.fullName && !nameRegex.test(data.fullName)) throw new Error("Họ tên không được chứa ký tự đặc biệt");
    if (data.phoneNumber && !phoneRegex.test(data.phoneNumber)) throw new Error("Số điện thoại không hợp lệ");
    if (data.birthday && Number.isNaN(Date.parse(data.birthday))) throw new Error("Ngày sinh không hợp lệ");
    if (data.idCard?.idNumber) {
        const clean = String(data.idCard.idNumber).trim();
        if (!clean.startsWith("enc:") && !idCardRegex.test(clean)) {
            throw new Error("Số CCCD / CMND phải gồm đúng 9 hoặc 12 chữ số");
        }
    }
    
    // Validate Account fields
    if (data.email && !emailRegex.test(data.email)) throw new Error("Email không hợp lệ");
};
