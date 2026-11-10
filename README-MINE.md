# ZERO-DELAY 5-BLOCK MINE

`/mine` đã được đổi sang burst không delay phía client.

Luồng mỗi lượt:

```text
[B1] [B2] [B3] [B4] [B5]
  ↓    ↓    ↓    ↓    ↓
START START START START START
  ↓    ↓    ↓    ↓    ↓
STOP  STOP  STOP  STOP  STOP
```

Đặc điểm:
- Không tính `digTime` trong `/mine`.
- Không `setTimeout` giữa các block.
- Không `sleep(1ms)` hoặc `sleep(5ms)` giữa các batch.
- Không `await bot.dig()`.
- 5 START được gửi liên tiếp.
- 5 STOP được gửi liên tiếp ngay sau đó.
- Không tự quay giữa B1 → B5.
- B1 lấy theo crosshair; B2–B5 nằm liên tiếp trên cùng trục nhìn.
- Tọa độ đang chờ được giữ cho tới khi world cập nhật block, tránh spam cùng một tọa độ.

## Build

```powershell
npm install
npm run build
npm run start:prod
```

Nếu chạy source trực tiếp:

```powershell
npm install
npm run start
```

Lưu ý: server Minecraft có thể tự giới hạn hoặc từ chối nhiều `block_dig` packet trong cùng tick. Bản này loại bỏ delay ở phía client; nó không thể ép server xử lý nhiều block nếu server có giới hạn riêng.


## /go
`/go W 5` giữ W trong 5ms rồi tự nhả. Hỗ trợ W/S/A/D/SPACE. `/stop` nhả toàn bộ phím.

## LV50 Auto CapDaoExp
Khi `/mine` đang chạy và `bot.experience.level >= 50`, bot sẽ pause vòng đào, chạy 5 lệnh sell, `/capdaoexp`, click slot 19 rồi đóng GUI và resume đào.

Quan trọng: `/mine` luôn arm lại kiểm tra khi khởi động. Vì vậy nếu bot đã ở LV100 trước khi gõ `/mine`, flow LV50 vẫn chạy ngay; không cần phải vừa chuyển từ 49 lên 50.

Flow chỉ chạy một lần trong khi level vẫn >= 50. Nếu level xuống dưới 50 rồi lại đạt >= 50, flow được arm lại.
