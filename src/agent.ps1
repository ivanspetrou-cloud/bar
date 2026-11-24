# Bar agent — постоянный помощник на PowerShell: звук, микрофон, раскладка, окна, текущий трек,
# Bluetooth-устройства, сеть. Читает команды построчно из stdin: "<id> <cmd> [arg]",
# отвечает строкой JSON: {"id":..,"ok":true,"data":..}. Сам ничего не опрашивает — только по запросу.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Bar {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

  public static class Audio {
    static IAudioEndpointVolume Vol(int flow) {
      var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
      IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(flow, 1, out dev));
      Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol(0).GetMasterVolumeLevelScalar(out v)); return v; }
    public static void SetVolume(float v) { Marshal.ThrowExceptionForHR(Vol(0).SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), Guid.Empty)); }
    public static bool GetMute(int flow) { bool m; Marshal.ThrowExceptionForHR(Vol(flow).GetMute(out m)); return m; }
    public static void SetMute(int flow, bool m) { Marshal.ThrowExceptionForHR(Vol(flow).SetMute(m, Guid.Empty)); }
    public static bool HasMic() { try { Vol(1); return true; } catch { return false; } }

    // Ожидание изменения громкости / звука / микрофона (для всплывашки в нотче).
    // Цикл внутри процесса: 12 лёгких чтений в секунду, наружу — ответ только при изменении или по таймауту.
    public static string WaitChange(int vol, int mute, int mic, int timeoutMs) {
      var sw = Stopwatch.StartNew();
      IAudioEndpointVolume o = null, i = null; long got = -10000;
      while (true) {
        try {
          if (sw.ElapsedMilliseconds - got > 2000) { o = Vol(0); try { i = Vol(1); } catch { i = null; } got = sw.ElapsedMilliseconds; } // устройство могли сменить
          float v; bool m, mm = false;
          o.GetMasterVolumeLevelScalar(out v); o.GetMute(out m);
          if (i != null) i.GetMute(out mm);
          int vp = (int)Math.Round(v * 100), mi = m ? 1 : 0, mmi = mm ? 1 : 0;
          if (vp != vol || mi != mute || (i != null && mmi != mic) || sw.ElapsedMilliseconds >= timeoutMs)
            return vp + "|" + mi + "|" + (i != null ? 1 : 0) + "|" + mmi;
        } catch { o = null; got = -10000; if (sw.ElapsedMilliseconds >= timeoutMs) return ""; }
        Thread.Sleep(80);
      }
    }

  }

  public static class Win {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern int GetKeyboardLayoutList(int n, IntPtr[] list);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] static extern IntPtr GetClassLongPtr(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder sb, ref uint size);
    delegate bool EnumProc(IntPtr h, IntPtr p);

    // Окно, в котором человек печатает: последнее активное окно, не принадлежащее Bar.
    // Когда нотч раскрыт и в фокусе, раскладку показываем и меняем именно для этого окна.
    static IntPtr lastFg = IntPtr.Zero;
    static readonly uint barPid = ParsePid(Environment.GetEnvironmentVariable("BAR_PID"));
    static uint ParsePid(string s) { uint v; return uint.TryParse(s, out v) ? v : 0; }
    static IntPtr Target() {
      IntPtr fg = GetForegroundWindow(); uint pid;
      GetWindowThreadProcessId(fg, out pid);
      if (fg != IntPtr.Zero && pid != barPid && pid != (uint)System.Diagnostics.Process.GetCurrentProcess().Id) lastFg = fg;
      if (lastFg != IntPtr.Zero && !IsWindow(lastFg)) lastFg = IntPtr.Zero;
      return lastFg != IntPtr.Zero ? lastFg : fg;
    }
    static string LangName(long hkl) {
      try { return new System.Globalization.CultureInfo((int)(hkl & 0xFFFF)).Name; } catch { return ""; }
    }

    // Язык раскладки окна, где печатают, например "ru-RU"
    public static string Layout() {
      uint pid; uint tid = GetWindowThreadProcessId(Target(), out pid);
      return LangName((long)GetKeyboardLayout(tid));
    }

    // Иконка окна (HICON), которую программа поставила сама — для программ без иконки в exe
    public static long WindowIcon(long hwnd) {
      var h = new IntPtr(hwnd); IntPtr r;
      SendMessageTimeout(h, 0x7F, new IntPtr(1), IntPtr.Zero, 2, 300, out r);           // WM_GETICON, ICON_BIG
      if (r == IntPtr.Zero) SendMessageTimeout(h, 0x7F, new IntPtr(2), IntPtr.Zero, 2, 300, out r); // ICON_SMALL2
      if (r == IntPtr.Zero) r = GetClassLongPtr(h, -14);                                 // GCLP_HICON
      return r.ToInt64();
    }

    // Программа активного окна (кроме Bar): путь к exe — для подсказок дока
    public static string Foreground() {
      IntPtr t = Target(); if (t == IntPtr.Zero) return "";
      uint pid; GetWindowThreadProcessId(t, out pid);
      return ExePath(pid);
    }

    // ---------- игровой режим: что на переднем плане и на весь ли экран ----------
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out GRECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref GMONINFO mi);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    [StructLayout(LayoutKind.Sequential)] struct GRECT { public int l, t, r, b; }
    [StructLayout(LayoutKind.Sequential)] struct GMONINFO { public int cbSize; public GRECT mon; public GRECT work; public uint flags; }
    // "полноэкранное(1/0)|состояние уведомлений|exe|pid|монитор x,y,w,h (физические пиксели)"
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    // активное окно развёрнуто на весь экран (кнопкой «развернуть»)? → монитор «l,t,r,b» в физических пикселях
    public static string FgMaximized() {
      IntPtr h = Target();
      if (h == IntPtr.Zero || !IsZoomed(h)) return "";
      var mi = new GMONINFO(); mi.cbSize = Marshal.SizeOf(typeof(GMONINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "";
      return mi.mon.l + "," + mi.mon.t + "," + mi.mon.r + "," + mi.mon.b;
    }
    public static string GameState() {
      IntPtr h = Target();
      if (h == IntPtr.Zero) return "";
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return "";
      GRECT r; GetWindowRect(h, out r);
      var mi = new GMONINFO(); mi.cbSize = Marshal.SizeOf(typeof(GMONINFO));
      GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
      // развёрнутое окно (кнопка «развернуть») тоже вылезает за края монитора на рамку — но это не полноэкранная игра
      bool full = !IsZoomed(h) && r.l <= mi.mon.l && r.t <= mi.mon.t && r.r >= mi.mon.r && r.b >= mi.mon.b;
      uint pid; GetWindowThreadProcessId(h, out pid);
      int q = 0; try { SHQueryUserNotificationState(out q); } catch {}
      return (full ? "1" : "0") + "|" + q + "|" + ExePath(pid) + "|" + pid + "|" + mi.mon.l + "," + mi.mon.t + "," + (mi.mon.r - mi.mon.l) + "," + (mi.mon.b - mi.mon.t);
    }

    // Установленные раскладки: "hkl|ru-RU|Русский (Россия)|1 — текущая"
    public static string[] Layouts() {
      uint pid; uint tid = GetWindowThreadProcessId(Target(), out pid);
      long cur = (long)GetKeyboardLayout(tid);
      int n = GetKeyboardLayoutList(0, null);
      var arr = new IntPtr[n]; GetKeyboardLayoutList(n, arr);
      var list = new List<string>();
      foreach (var h in arr) {
        long v = (long)h; string disp = "";
        try { var ci = new System.Globalization.CultureInfo((int)(v & 0xFFFF)); disp = ci.DisplayName; } catch {}
        list.Add(v + "|" + LangName(v) + "|" + disp + "|" + (v == cur ? "1" : "0"));
      }
      return list.ToArray();
    }

    // Переключить раскладку в окне, где печатают, и вернуть ему фокус
    public static string SetLayout(long hkl) {
      IntPtr t = Target();
      if (t == IntPtr.Zero) return "";
      PostMessage(t, 0x0050, IntPtr.Zero, new IntPtr(hkl)); // WM_INPUTLANGCHANGEREQUEST
      Focus(t.ToInt64());
      return LangName(hkl);
    }

    static string ExePath(uint pid) {
      IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
      try { var sb = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; }
      finally { CloseHandle(h); }
    }

    // Видимые окна верхнего уровня, как в панели задач: "hwnd|pid|exe"
    public static string[] Windows() {
      var list = new List<string>();
      EnumWindows((h, p) => {
        if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
        if (GetWindow(h, 4) != IntPtr.Zero) return true;               // есть владелец
        if ((GetWindowLong(h, -20) & 0x80) != 0) return true;           // WS_EX_TOOLWINDOW
        int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(h.ToInt64() + "|" + pid + "|" + ExePath(pid));
        return true;
      }, IntPtr.Zero);
      return list.ToArray();
    }

    // Для таскбара Bar: окно|процесс|exe|свёрнуто|активно|монитор (физ. пиксели l,t,r,b)|заголовок (заголовок — последним: в нём может быть «|»)
    static string MonRect(IntPtr h) { var mi = new GMONINFO(); mi.cbSize = Marshal.SizeOf(typeof(GMONINFO)); if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return ""; var m = mi.mon; return m.l + "," + m.t + "," + m.r + "," + m.b; }
    public static string[] TaskWindows() {
      var list = new List<string>();
      IntPtr fg = GetForegroundWindow();
      EnumWindows((h, p) => {
        if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
        if (GetWindow(h, 4) != IntPtr.Zero) return true;
        if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
        int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        list.Add(h.ToInt64() + "|" + pid + "|" + ExePath(pid) + "|" + (IsIconic(h) ? 1 : 0) + "|" + (h == fg ? 1 : 0) + "|" + MonRect(h) + "|" + sb.ToString().Replace((char)13, ' ').Replace((char)10, ' '));
        return true;
      }, IntPtr.Zero);
      return list.ToArray();
    }
    // Снимок одного окна для превью в таскбаре: PrintWindow (с отрисовкой DWM) → уменьшенный JPEG в base64.
    // Только по запросу, только запрошенные окна; свёрнутые не снимаются.
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    public static string Thumb(long hwnd, int maxW, int maxH) {
      var h = new IntPtr(hwnd);
      if (IsIconic(h)) return "";
      GRECT r; GetWindowRect(h, out r);
      int w = r.r - r.l, hh = r.b - r.t;
      if (w <= 0 || hh <= 0 || w > 10000 || hh > 10000) return "";
      using (var bmp = new System.Drawing.Bitmap(w, hh, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
          var hdc = g.GetHdc(); bool ok = PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc);
          if (!ok) return "";
        }
        double k = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / hh));
        int tw = Math.Max(1, (int)(w * k)), th = Math.Max(1, (int)(hh * k));
        using (var sm = new System.Drawing.Bitmap(tw, th))
        using (var g2 = System.Drawing.Graphics.FromImage(sm))
        using (var ms = new System.IO.MemoryStream()) {
          g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g2.DrawImage(bmp, 0, 0, tw, th);
          // JPEG с качеством 90: по умолчанию (~75) мелкий текст окон мылится
          var enc = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), (c) => c.MimeType == "image/jpeg");
          var ep = new System.Drawing.Imaging.EncoderParameters(1);
          ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
          sm.Save(ms, enc, ep);
          return Convert.ToBase64String(ms.ToArray());
        }
      }
    }
    // закрыть одно конкретное окно (как крестик в его заголовке), а не всю программу
    public static bool CloseWindow(long hwnd) { return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }
    public static void StartMenu() { keybd_event(0x5B, 0, 0, UIntPtr.Zero); keybd_event(0x5B, 0, 2, UIntPtr.Zero); }
    public static void ShowDesktop() { keybd_event(0x5B, 0, 0, UIntPtr.Zero); keybd_event(0x44, 0, 0, UIntPtr.Zero); keybd_event(0x44, 0, 2, UIntPtr.Zero); keybd_event(0x5B, 0, 2, UIntPtr.Zero); }

    public static bool Focus(long hwnd) {
      var h = new IntPtr(hwnd);
      if (IsIconic(h)) ShowWindow(h, 9);
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt снимает блокировку переднего плана
      return SetForegroundWindow(h);
    }
    public static void Minimize(long hwnd) { ShowWindow(new IntPtr(hwnd), 6); }

    // Скрыть / показать окна процесса (окно Edge с музыкой): без окна и без значка на панели задач,
    // звук при этом продолжает играть. Скрытые окна запоминаем, чтобы вернуть ровно их.
    static readonly Dictionary<int, List<IntPtr>> hidden = new Dictionary<int, List<IntPtr>>();
    public static int HideProcess(int pid) {
      var list = new List<IntPtr>();
      EnumWindows((h, p) => {
        uint wp; GetWindowThreadProcessId(h, out wp);
        if (wp == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetWindow(h, 4) == IntPtr.Zero) list.Add(h);
        return true;
      }, IntPtr.Zero);
      foreach (var h in list) ShowWindow(h, 0);
      if (!hidden.ContainsKey(pid)) hidden[pid] = new List<IntPtr>();
      hidden[pid].AddRange(list);
      return list.Count;
    }
    public static int ShowProcess(int pid) {
      List<IntPtr> list;
      if (!hidden.TryGetValue(pid, out list)) return 0;
      foreach (var h in list) { ShowWindow(h, 9); SetForegroundWindow(h); }
      hidden.Remove(pid);
      return list.Count;
    }
  }

  // ---------- заряд устройств с собственными приёмниками (не Bluetooth) ----------
  // Только запросы на чтение, как в openrazer и OpenLinkHub.
  public static class HidBattery {
    [StructLayout(LayoutKind.Sequential)] struct IFDATA { public int cbSize; public Guid g; public int Flags; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct HIDP_CAPS {
      public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
      public ushort a, b, c, d, e, f, g, h, i, j;
    }
    [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr h, int f);
    [DllImport("setupapi.dll")] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref IFDATA data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref IFDATA d, IntPtr detail, int size, out int req, IntPtr info);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string p, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
    [DllImport("hid.dll", CharSet = CharSet.Unicode)] static extern bool HidD_GetProductString(Microsoft.Win32.SafeHandles.SafeFileHandle h, StringBuilder b, int len);
    [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(Microsoft.Win32.SafeHandles.SafeFileHandle h, out IntPtr p);
    [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, out HIDP_CAPS c);
    [DllImport("hid.dll")] static extern bool HidD_SetFeature(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] b, int len);
    [DllImport("hid.dll")] static extern bool HidD_GetFeature(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] b, int len);

    static List<string> Paths(string vid) {
      var res = new List<string>(); Guid g; HidD_GetHidGuid(out g);
      IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
      var d = new IFDATA(); d.cbSize = Marshal.SizeOf(d);
      for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++) {
        int req; SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
        IntPtr buf = Marshal.AllocHGlobal(req); Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
        if (SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, IntPtr.Zero)) {
          string p = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4));
          if (p.ToLower().Contains("vid_" + vid)) res.Add(p);
        }
        Marshal.FreeHGlobal(buf);
      }
      SetupDiDestroyDeviceInfoList(set);
      return res;
    }
    static Microsoft.Win32.SafeHandles.SafeFileHandle Open(string p, uint access, uint flags) { return CreateFile(p, access, 3, IntPtr.Zero, 3, flags, IntPtr.Zero); }
    static bool Caps(string p, out HIDP_CAPS c, out string name) {
      c = new HIDP_CAPS(); name = "";
      using (var h = Open(p, 0, 0)) {
        if (h.IsInvalid) return false;
        var sb = new StringBuilder(256); HidD_GetProductString(h, sb, 512); name = sb.ToString();
        IntPtr pp; if (!HidD_GetPreparsedData(h, out pp)) return false;
        HidP_GetCaps(pp, out c); HidD_FreePreparsedData(pp); return true;
      }
    }

    // Razer: служебный feature-отчёт 90 байт (класс 0x07: 0x80 — заряд, 0x84 — зарядка)
    static byte[] RazerCmd(string p, byte tid, byte id) {
      using (var h = Open(p, 0, 0)) {   // без прав чтения/записи — мышь система держит монопольно
        if (h.IsInvalid) return null;
        var b = new byte[91]; b[2] = tid; b[6] = 0x02; b[7] = 0x07; b[8] = id;
        byte crc = 0; for (int i = 3; i < 89; i++) crc ^= b[i]; b[89] = crc;
        if (!HidD_SetFeature(h, b, 91)) return null;
        for (int t = 0; t < 12; t++) {
          Thread.Sleep(25);
          var r = new byte[91];
          if (!HidD_GetFeature(h, r, 91)) continue;
          if (r[1] == 0x02 || r[1] == 0x04) return r;   // 0x04 — мышь спит / вне связи
          if (r[1] != 0x00 && r[1] != 0x01) return null;
        }
        return null;
      }
    }

    // Corsair Bragi: отчёт 0x02 → [endpoint, 0x02 = прочитать, свойство]; ответ в отчёте 0x01
    static byte[] Bragi(string p, byte ep, byte prop) {
      var h = Open(p, 0xC0000000u, 0x40000000u);
      if (h.IsInvalid) return null;
      using (var fs = new System.IO.FileStream(h, System.IO.FileAccess.ReadWrite, 64, true)) {
        var w = new byte[64]; w[0] = 0x02; w[1] = ep; w[2] = 0x02; w[3] = prop;
        fs.Write(w, 0, 64);
        var until = DateTime.Now.AddMilliseconds(800);
        while (DateTime.Now < until) {
          var r = new byte[64];
          var task = fs.ReadAsync(r, 0, 64);
          int left = (int)(until - DateTime.Now).TotalMilliseconds;
          if (left <= 0 || !task.Wait(left)) return null;
          if (r[0] == 0x01 && r[2] == 0x02) return r;
        }
      }
      return null;
    }


    // Ajazz / Sonix 2.4G (0C45, канал 0xFF60 с отчётами 33 байта) — протокол из
    // gist TheJenos «AK820 Pro HID protocol spec»: 0x02 — проверка связи, 0x20 0x01 — заряд.
    // Обе команды только читают. Прошивки, которые заряд не сообщают, отвечают нулём.
    static byte[] Radio(string p, byte cmd, byte len) {
      var h = Open(p, 0xC0000000u, 0x40000000u);
      if (h.IsInvalid) return null;
      using (var fs = new System.IO.FileStream(h, System.IO.FileAccess.ReadWrite, 33, true)) {
        var f = new byte[33]; f[1] = cmd; f[2] = len;
        int sum = 0; for (int i = 0; i < 32; i++) sum += f[i]; f[32] = (byte)(sum & 0xFF);
        fs.Write(f, 0, 33);
        var until = DateTime.Now.AddMilliseconds(300);
        while (DateTime.Now < until) {
          var r = new byte[33];
          var task = fs.ReadAsync(r, 0, 33);
          int left = (int)(until - DateTime.Now).TotalMilliseconds;
          if (left <= 0 || !task.Wait(left)) return null;
          if (r[1] == cmd && r[2] == len && r[3] == 0) return r;
        }
      }
      return null;
    }

    // SteelSeries Arctis Nova (1038): запрос статуса 0xB0 на интерфейс 3 (как драйвер Linux hid-steelseries и HeadsetControl).
    // Ответ: [B0, 03 = на связи, заряд, 01 = заряжается]. У Nova 7 первого поколения заряд 0..4, у Gen 2 — проценты.
    // Gen 2 может прислать ответ на интерфейс 5 — слушаем оба. Команда только читает состояние.
    static byte[] Arctis(string pw, List<string> readers, int outLen) {
      var hs = new List<System.IO.FileStream>();
      try {
        foreach (var rp in readers) { var rh = Open(rp, 0xC0000000u, 0x40000000u); if (!rh.IsInvalid) hs.Add(new System.IO.FileStream(rh, System.IO.FileAccess.ReadWrite, 64, true)); }
        var wh = Open(pw, 0xC0000000u, 0x40000000u);
        if (wh.IsInvalid) return null;
        using (var w = new System.IO.FileStream(wh, System.IO.FileAccess.ReadWrite, 64, true)) {
          var buf = new byte[Math.Max(2, outLen)]; buf[0] = 0x00; buf[1] = 0xB0;
          w.Write(buf, 0, buf.Length);
          var until = DateTime.Now.AddMilliseconds(700);
          var all = new List<System.IO.FileStream>(hs); all.Add(w);
          var bufs = new Dictionary<System.Threading.Tasks.Task<int>, byte[]>();
          foreach (var f in all) { var r = new byte[64]; bufs[f.ReadAsync(r, 0, 64)] = r; }
          while (DateTime.Now < until && bufs.Count > 0) {
            int left = (int)(until - DateTime.Now).TotalMilliseconds; if (left <= 0) break;
            var arr = new System.Threading.Tasks.Task[bufs.Count]; int k = 0; foreach (var t in bufs.Keys) arr[k++] = t;
            int i = System.Threading.Tasks.Task.WaitAny(arr, left); if (i < 0) break;
            var done = (System.Threading.Tasks.Task<int>)arr[i]; var data = bufs[done]; bufs.Remove(done);
            if (done.Status != System.Threading.Tasks.TaskStatus.RanToCompletion) continue;
            // в Windows первый байт — номер отчёта (0); данные с data[1]
            if (data[1] == 0xB0) return data;
          }
        }
      } catch { }
      finally { foreach (var f in hs) try { f.Dispose(); } catch { } }
      return null;
    }

    // Compx (3554: GravaStar M1/K1, VXE, ATK и др.): протокол из веб-драйвера ATK HUB для этих приёмников.
    // Отчёт 0x08, 16 байт: [команда, статус, адрес(2), длина, данные…, контрольная сумма = 0x55 − (8 + сумма байт 0..14)].
    // Команда 0x04 — «заряд»: ответ [0x04, статус, …, заряд %, 1 = заряжается]. Только чтение.
    static byte[] Compx(string p) {
      var h = Open(p, 0xC0000000u, 0x40000000u);
      if (h.IsInvalid) return null;
      try {
        using (var fs = new System.IO.FileStream(h, System.IO.FileAccess.ReadWrite, 17, true)) {
          var w = new byte[17]; w[0] = 0x08; w[1] = 0x04;
          int sum = 8; for (int i = 1; i <= 15; i++) sum += w[i];
          w[16] = (byte)((0x55 - (sum & 0xFF)) & 0xFF);
          fs.Write(w, 0, 17);
          var until = DateTime.Now.AddMilliseconds(600);
          while (DateTime.Now < until) {
            var r = new byte[17];
            var task = fs.ReadAsync(r, 0, 17);
            int left = (int)(until - DateTime.Now).TotalMilliseconds;
            if (left <= 0 || !task.Wait(left)) return null;
            if (r[0] == 0x08 && r[1] == 0x04) return r;
          }
        }
      } catch { }
      return null;
    }

    static string lastKb = null;
    static string Pretty(string n) {
      n = n.Replace("Gaming Receiver", "").Replace("Receiver", "").Replace("Wireless", "").Replace("Gaming", "").Replace("RGB", "");
      n = System.Text.RegularExpressions.Regex.Replace(n, @"\s+", " ").Trim();
      if (n.StartsWith("CORSAIR ")) n = "Corsair " + n.Substring(8);
      return n;
    }

    // "имя|уровень|подключено|заряжается|тип"
    public static string[] Read() {
      var outp = new List<string>();
      var seen = new HashSet<string>();
      foreach (var p in Paths("1532")) {
        HIDP_CAPS c; string name;
        if (!Caps(p, out c, out name) || c.FeatureReportByteLength != 91) continue;
        string key = name + "|razer"; if (seen.Contains(key)) continue;
        // 0x1F — беспроводные мыши Razer (HyperSpeed); 0x3F/0x08 — остальные модели.
        // Ответ 0x04 = приёмник не успел (например, занят Synapse) — повторяем, а не считаем мышь спящей.
        foreach (byte tid in new byte[] { 0x1F, 0x3F, 0x08 }) {
          byte[] r = null;
          for (int attempt = 0; attempt < 4; attempt++) {
            r = RazerCmd(p, tid, 0x80);
            if (r == null || r[1] == 0x02) break;
            Thread.Sleep(150);
          }
          if (r == null) continue;
          string kind = c.Usage == 0x06 ? "keyboard" : c.Usage == 0x02 ? "mouse" : (name.ToLower().Contains("kraken") || name.ToLower().Contains("barracuda") ? "headphones" : "mouse");
          if (r[1] == 0x04) { outp.Add(Pretty(name) + "|-1|0|0|" + kind); seen.Add(key); break; }
          var ch = RazerCmd(p, tid, 0x84);
          outp.Add(Pretty(name) + "|" + Math.Round(r[10] / 255.0 * 100) + "|1|" + (ch != null && ch[1] == 0x02 && ch[10] != 0 ? "1" : "0") + "|" + kind);
          seen.Add(key); break;
        }
      }
      foreach (var p in Paths("1b1c")) {
        HIDP_CAPS c; string name;
        if (!Caps(p, out c, out name) || c.UsagePage != 0xFF42 || c.Usage != 0x01 || c.OutputReportByteLength != 64) continue;
        if (seen.Contains(name)) continue;
        var lv = Bragi(p, 0x09, 0x0F);
        if (lv == null) continue;
        seen.Add(name);
        string kind = name.ToLower().Contains("headset") || System.Text.RegularExpressions.Regex.IsMatch(name, @"\b(HS\d+|VOID|VIRTUOSO)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ? "headphones"
          : name.ToLower().Contains("mouse") ? "mouse" : name.ToLower().Contains("keyboard") || name.Contains(" K") ? "keyboard" : "headphones";
        if (lv[3] != 0x00) { outp.Add(Pretty(name) + "|-1|0|0|" + kind); continue; }   // гарнитура выключена или вне зоны
        int level = (lv[4] | (lv[5] << 8)) / 10;
        if (level <= 0) { outp.Add(Pretty(name) + "|-1|0|0|" + kind); continue; }   // пустой ответ, а не 0%
        var st = Bragi(p, 0x09, 0x10);
        // статус батареи Bragi: 1 — заряжается, 2 — разряжается (обычная работа), 3 — заряжена
        bool charging = st != null && st[3] == 0x00 && st[4] == 0x01;
        outp.Add(Pretty(name) + "|" + level + "|1|" + (charging ? "1" : "0") + "|" + kind);
      }
      {
        var ss = Paths("1038");
        string w3 = null; var rd = new List<string>(); int outLen = 64; string ssName = "";
        foreach (var p in ss) {
          string lp = p.ToLower();
          HIDP_CAPS c; string name;
          if (!Caps(p, out c, out name)) continue;
          if (lp.Contains("&mi_03") && c.OutputReportByteLength > 0 && w3 == null) { w3 = p; outLen = c.OutputReportByteLength; ssName = name; }
          else if (lp.Contains("&mi_05") && c.InputReportByteLength > 0) rd.Add(p);
        }
        if (w3 != null && !seen.Contains("ss" + ssName)) {
          seen.Add("ss" + ssName);
          var r = Arctis(w3, rd, outLen);
          string nm = Pretty(string.IsNullOrEmpty(ssName) ? "Arctis Nova" : ssName);
          if (r == null || r[2] != 0x03) outp.Add(nm + "|-1|0|0|headphones");          // наушники выключены или вне связи
          else {
            int raw = r[3];
            int lvl = raw <= 4 ? raw * 25 : Math.Min(raw, 100);                        // Gen 1: 0..4, Gen 2: проценты
            outp.Add(nm + "|" + lvl + "|1|" + (r[4] == 0x01 ? "1" : "0") + "|headphones");
          }
        }
      }
      foreach (var p in Paths("3554")) {
        HIDP_CAPS c; string name;
        // только интерфейс с пакетами ровно этого протокола: свой отчёт (vendor-страница) и 16 байт + номер отчёта
        if (!Caps(p, out c, out name) || c.UsagePage < 0xFF00 || c.OutputReportByteLength != 17 || c.InputReportByteLength != 17) continue;
        string nm = Pretty(string.IsNullOrEmpty(name) ? "2.4G" : name);
        if (seen.Contains("cx" + nm)) continue;
        seen.Add("cx" + nm);
        string ln = nm.ToLower();
        string kind = System.Text.RegularExpressions.Regex.IsMatch(ln, @"\bk\d|keyboard|kb") ? "keyboard" : System.Text.RegularExpressions.Regex.IsMatch(ln, @"\bm\d|mouse") ? "mouse" : "mouse";
        var r = Compx(p);
        if (r == null || r[2] != 0x00) { outp.Add(nm + "|-1|0|0|" + kind); continue; }   // приёмник есть, устройство спит или вне связи
        int lvl = Math.Min((int)r[6], 100);
        outp.Add(nm + "|" + (lvl > 0 ? lvl : -2) + "|1|" + (r[7] == 0x01 ? "1" : "0") + "|" + kind);
      }
      foreach (var p in Paths("0c45")) {
        HIDP_CAPS c; string name;
        if (!Caps(p, out c, out name) || c.UsagePage != 0xFF60 || c.InputReportByteLength != 33 || c.OutputReportByteLength != 33) continue;
        if (!name.ToLower().Contains("dongle") || seen.Contains("aj" + name)) continue;
        seen.Add("aj" + name);
        byte[] hs = null;
        for (int a = 0; a < 3 && hs == null; a++) { hs = Radio(p, 0x02, 0); if (hs == null) Thread.Sleep(120); }
        // в ответе на проверку связи — VID/PID самой клавиатуры: 0C45:8009 = AK820 Pro
        string kname = hs != null && hs[8] == 0x45 && hs[9] == 0x0C && hs[10] == 0x09 && hs[11] == 0x80 ? "Ajazz AK820 Pro" : new string(new char[] { (char)0x41A, (char)0x43B, (char)0x430, (char)0x432, (char)0x438, (char)0x430, (char)0x442, (char)0x443, (char)0x440, (char)0x430 }) + " 2.4G";
        if (hs != null) lastKb = kname; else if (lastKb != null) kname = lastKb;
        if (hs == null) { outp.Add(kname + "|-1|0|0|keyboard"); continue; }
        var b = Radio(p, 0x20, 0x01);
        int lvl = b != null ? Math.Min((int)b[4], 100) : 0;
        outp.Add(kname + "|" + (lvl > 0 ? lvl : -2) + "|1|0|keyboard");   // -2 = на связи, заряд не сообщает
      }
      return outp.ToArray();
    }
  }


  // ---------- управление веб-камерой (UVC через DirectShow IAMCameraControl) ----------
  // Поворот, наклон, зум, фокус и приватность — стандартные свойства камер; EMEET PIXY и другие PTZ-камеры
  // отдают их без своих программ. Только то, что камера сама объявляет (GetRange), — остальное не трогаем.
  [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ICreateDevEnum { [PreserveSig] int CreateClassEnumerator([In] ref Guid type, out System.Runtime.InteropServices.ComTypes.IEnumMoniker e, int flags); }
  [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyBag { [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string name, out object val, IntPtr log); [PreserveSig] int Write(string name, ref object val); }
  [ComImport, Guid("C6E13370-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAMCameraControl {
    [PreserveSig] int GetRange(int prop, out int min, out int max, out int step, out int def, out int caps);
    [PreserveSig] int Set(int prop, int val, int flags);
    [PreserveSig] int Get(int prop, out int val, out int flags);
  }
  public static class Cam {
    // 0 Pan, 1 Tilt, 2 Roll, 3 Zoom, 4 Exposure, 5 Iris, 6 Focus, 15 Privacy (KSPROPERTY_CAMERACONTROL_PRIVACY)
    static readonly int[] PROPS = { 0, 1, 2, 3, 4, 6, 15 };
    static List<KeyValuePair<string, IAMCameraControl>> Devices() {
      var res = new List<KeyValuePair<string, IAMCameraControl>>();
      var t = Type.GetTypeFromCLSID(new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86"));
      var de = (ICreateDevEnum)Activator.CreateInstance(t);
      Guid cat = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
      System.Runtime.InteropServices.ComTypes.IEnumMoniker em;
      if (de.CreateClassEnumerator(ref cat, out em, 0) != 0 || em == null) return res;
      var arr = new System.Runtime.InteropServices.ComTypes.IMoniker[1];
      while (em.Next(1, arr, IntPtr.Zero) == 0) {
        var m = arr[0]; string name = "";
        try {
          object bag; Guid ib = typeof(IPropertyBag).GUID; m.BindToStorage(null, null, ref ib, out bag);
          object v; if (((IPropertyBag)bag).Read("FriendlyName", out v, IntPtr.Zero) == 0) name = (string)v;
        } catch { }
        IAMCameraControl cc = null;
        try { object f; Guid bf = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770"); m.BindToObject(null, null, ref bf, out f); cc = f as IAMCameraControl; } catch { }
        res.Add(new KeyValuePair<string, IAMCameraControl>(name, cc));
      }
      return res;
    }
    // "номер|имя|свойство:мин:макс:шаг:по умолч.:сейчас:авто,..."  (авто: 1 — свойство в авторежиме)
    public static string[] List() {
      var outp = new List<string>(); int i = 0;
      foreach (var d in Devices()) {
        var props = new List<string>();
        if (d.Value != null) foreach (int pr in PROPS) {
          int mn, mx, st, df, cp, cur, fl;
          if (d.Value.GetRange(pr, out mn, out mx, out st, out df, out cp) != 0 || mx <= mn) continue;
          if (d.Value.Get(pr, out cur, out fl) != 0) cur = df;
          props.Add(pr + ":" + mn + ":" + mx + ":" + st + ":" + df + ":" + cur + ":" + ((fl & 1) != 0 ? 1 : 0) + ":" + ((cp & 1) != 0 ? 1 : 0));
        }
        outp.Add(i + "|" + d.Key + "|" + string.Join(",", props) + "|" + (d.Value != null ? 1 : 0)); // последнее поле: есть ли у камеры управление вообще
        i++;
      }
      return outp.ToArray();
    }
    // установить свойство; auto=1 — вернуть камере автоматический режим (фокус, экспозиция)
    public static string Set(int dev, int prop, int val, int auto) {
      var ds = Devices();
      if (dev < 0 || dev >= ds.Count || ds[dev].Value == null) return "nodev";
      int mn, mx, st, df, cp;
      if (ds[dev].Value.GetRange(prop, out mn, out mx, out st, out df, out cp) != 0) return "noprop";
      val = Math.Max(mn, Math.Min(mx, val));
      int hr = ds[dev].Value.Set(prop, val, auto == 1 ? 1 : 2);
      int cur, fl; ds[dev].Value.Get(prop, out cur, out fl);
      return hr == 0 ? "ok:" + cur : "err:" + hr.ToString("X");
    }
  }

  // ---------- загрузка видеокарты (сумма 3D-движков всех процессов), только в игровом режиме ----------
  public static class Gpu {
    static readonly Dictionary<string, PerformanceCounter> ctr = new Dictionary<string, PerformanceCounter>();
    static DateTime scanned = DateTime.MinValue;
    public static int Usage() {
      if ((DateTime.Now - scanned).TotalSeconds > 60) {
        scanned = DateTime.Now;
        var names = new HashSet<string>();
        foreach (var n in new PerformanceCounterCategory("GPU Engine").GetInstanceNames()) if (n.Contains("engtype_3D")) names.Add(n);
        var gone = new List<string>(); foreach (var k in ctr.Keys) if (!names.Contains(k)) gone.Add(k);
        foreach (var k in gone) { ctr[k].Dispose(); ctr.Remove(k); }
        foreach (var n in names) if (!ctr.ContainsKey(n)) { try { var pc = new PerformanceCounter("GPU Engine", "Utilization Percentage", n, true); pc.NextValue(); ctr[n] = pc; } catch {} }
      }
      float sum = 0; var dead = new List<string>();
      foreach (var kv in ctr) { try { sum += kv.Value.NextValue(); } catch { dead.Add(kv.Key); } }
      foreach (var d in dead) ctr.Remove(d);
      return (int)Math.Round(Math.Min(100f, sum));
    }
  }


  // ---------- иконка приложения так, как её показывает «Пуск» (shell:AppsFolder\<AppID>) ----------
  public static class ShellIcon {
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, ref BITMAP bmp);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
    // PNG (base64) 64×64 с прозрачностью или пустая строка
    public static string Png(string appId, int size) {
      IShellItemImageFactory f;
      try { SHCreateItemFromParsingName("shell:AppsFolder\\" + appId, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f); } catch { return ""; }
      IntPtr hbm; var sz = new SIZE(); sz.cx = size; sz.cy = size;
      if (f.GetImage(sz, 0x4 /* SIIGBF_ICONONLY */, out hbm) != 0 || hbm == IntPtr.Zero) return "";
      try {
        var bm = new BITMAP(); GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm);
        if (bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32) return "";
        int w = bm.bmWidth, h = Math.Abs(bm.bmHeight), stride = bm.bmWidthBytes;
        var px = new byte[stride * h]; Marshal.Copy(bm.bmBits, px, 0, px.Length);
        using (var img = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
          var data = img.LockBits(new System.Drawing.Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
          // DIB снизу вверх (bmHeight > 0) — переворачиваем строки; альфа уже предумножена — снимаем предумножение
          for (int y = 0; y < h; y++) {
            int src = (bm.bmHeight > 0 ? h - 1 - y : y) * stride;
            var row = new byte[w * 4];
            for (int x = 0; x < w; x++) {
              byte b = px[src + x * 4], g = px[src + x * 4 + 1], r = px[src + x * 4 + 2], a = px[src + x * 4 + 3];
              if (a > 0 && a < 255) { b = (byte)Math.Min(255, b * 255 / a); g = (byte)Math.Min(255, g * 255 / a); r = (byte)Math.Min(255, r * 255 / a); }
              row[x * 4] = b; row[x * 4 + 1] = g; row[x * 4 + 2] = r; row[x * 4 + 3] = a;
            }
            Marshal.Copy(row, 0, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), w * 4);
          }
          img.UnlockBits(data);
          using (var ms = new System.IO.MemoryStream()) { img.Save(ms, System.Drawing.Imaging.ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
        }
      } finally { DeleteObject(hbm); }
    }
  }

  // ---------- панель задач: автоскрытие ----------
  public static class Taskbar {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
    [StructLayout(LayoutKind.Sequential)] struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint msg; public uint edge; public RECT rc; public IntPtr lParam; }
    [DllImport("shell32.dll")] static extern IntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    public static bool AutoHide() { var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); return ((long)SHAppBarMessage(4, ref d) & 1) != 0; }
    public static void SetAutoHide(bool on) {
      var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d);
      d.hWnd = FindWindow("Shell_TrayWnd", null);
      d.lParam = new IntPtr(on ? 1 : 2);
      SHAppBarMessage(10, ref d);
    }
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    // Панель задач Windows целиком: прятать, пока работает таскбар Bar (основная и панели на других мониторах)
    public static int Hide(bool hide) {
      int n = 0; int cmd = hide ? 0 : 5;
      var t = FindWindow("Shell_TrayWnd", null); if (t != IntPtr.Zero) { ShowWindow(t, cmd); n++; }
      IntPtr s2 = IntPtr.Zero;
      while ((s2 = FindWindowEx(IntPtr.Zero, s2, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) { ShowWindow(s2, cmd); n++; }
      return n;
    }
    // Резерв места у нижнего края (как у обычной панели): развёрнутые окна заканчиваются над таскбаром Bar.
    // Координаты — физические пиксели экрана. Возвращает итоговый прямоугольник «l t r b».
    public static string AppBarSet(long hwnd, int l, int t, int r, int b, int cbMsg) {
      var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = new IntPtr(hwnd); d.msg = (uint)cbMsg; d.edge = 3;
      SHAppBarMessage(0, ref d); // ABM_NEW (повторный вызов безвреден)
      int h = b - t;
      d.rc.l = l; d.rc.r = r; d.rc.b = b; d.rc.t = b - h;
      SHAppBarMessage(2, ref d); // ABM_QUERYPOS
      d.rc.t = d.rc.b - h;
      SHAppBarMessage(3, ref d); // ABM_SETPOS
      return d.rc.l + " " + d.rc.t + " " + d.rc.r + " " + d.rc.b;
    }
    // только подписка на уведомления (полноэкранные программы), без резерва места
    public static void AppBarNew(long hwnd, int cbMsg) { var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = new IntPtr(hwnd); d.msg = (uint)cbMsg; SHAppBarMessage(0, ref d); }
    public static void AppBarRemove(long hwnd) { var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = new IntPtr(hwnd); SHAppBarMessage(1, ref d); }
  }
}
'@ -ReferencedAssemblies System.Drawing

# ---------- WinRT: текущий трек ----------
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$script:asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(4000); $task.Result }
$script:smtc = $null
$script:artKey = ''
$script:artData = $null
function Get-Session {
  if (-not $script:smtc) { $script:smtc = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
  $script:smtc.GetCurrentSession()
}
function Get-NowPlaying {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $key = "$($p.Title)|$($p.Artist)"
  if ($key -ne $script:artKey) {
    $script:artKey = $key; $script:artData = $null
    if ($p.Thumbnail) {
      try {
        $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $net = $script:asStream.Invoke($null, @($st))
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        if ($bytes.Length -gt 0 -and $bytes.Length -lt 3MB) {
          $mime = if ($bytes[0] -eq 0x89) { 'image/png' } elseif ($bytes[0] -eq 0xFF) { 'image/jpeg' } else { 'image/png' }
          $script:artData = 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes)
        }
      } catch { $script:artData = $null }
    }
  }
  $app = $s.SourceAppUserModelId
  $playing = ($info.PlaybackStatus.ToString() -eq 'Playing')
  # browsers report the position only on play/pause/seek: add the time elapsed since that report
  $pos = $tl.Position.TotalSeconds; $dur = $tl.EndTime.TotalSeconds
  if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) {
    $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
    if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
  }
  [ordered]@{
    title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; app = $app
    playing = $playing
    position = [int]$pos; duration = [int]$dur
    art = $script:artData
  }
}
function Invoke-Media($what) {
  $s = Get-Session; if (-not $s) { return $false }
  if ($what -like 'seek:*') {
    # перемотка через системный медиаплеер (если источник это поддерживает); позиция — в 100-нс тиках
    $sec = [double]($what.Substring(5))
    return Await ($s.TryChangePlaybackPositionAsync([long]($sec * 10000000))) ([bool])
  }
  $op = switch ($what) { 'toggle' { $s.TryTogglePlayPauseAsync() } 'next' { $s.TrySkipNextAsync() } 'prev' { $s.TrySkipPreviousAsync() } }
  Await $op ([bool])
}

# ---------- Bluetooth ----------
function Get-BtBatteries {
  $kBat = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
  $kCon = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
  $devs = @(Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue)
  $props = @($devs | Get-PnpDeviceProperty -KeyName $kBat, $kCon -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($p in $props) { if (-not $byId[$p.InstanceId]) { $byId[$p.InstanceId] = @{} }; $byId[$p.InstanceId][$p.KeyName] = $p.Data }
  $out = @{}
  foreach ($d in $devs) {
    $v = $byId[$d.InstanceId]; if (-not $v -or $v[$kBat] -eq $null) { continue }
    $name = $d.FriendlyName; $con = [bool]$v[$kCon]
    if (-not $out[$name] -or ($con -and -not $out[$name].connected)) { $out[$name] = [ordered]@{ name = $name; level = [int]$v[$kBat]; connected = $con } }
  }
  @($out.Values)
}

# ---------- сеть ----------
function Get-NetState {
  $up = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up')
  $wifi = $null
  $w = netsh wlan show interfaces 2>$null
  if ($w) {
    $ssid = ($w | Select-String '^\s*SSID\s*:\s*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value
    $sig = ($w | Select-String ':\s*(\d+)%\s*$' | Select-Object -First 1).Matches.Groups[1].Value
    if ($ssid) { $wifi = [ordered]@{ ssid = $ssid.Trim(); signal = [int]$sig } }
  }
  $eth = $up | Where-Object { $_.MediaType -eq '802.3' } | Select-Object -First 1
  $stats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Where-Object { $up.Name -contains $_.Name }
  [ordered]@{
    ethernet = [bool]$eth; ethSpeed = if ($eth) { $eth.LinkSpeed } else { '' }
    wifi = $wifi; online = $up.Count -gt 0
    rx = [int64](($stats | Measure-Object ReceivedBytes -Sum).Sum); tx = [int64](($stats | Measure-Object SentBytes -Sum).Sum)
  }
}

# Как часто запускают программы — счётчики самой Windows (UserAssist, имена в ROT13).
# Только чтение и только на этом компьютере: "имя|запусков|мс в фокусе|последний запуск (unix ms)"
function Get-AppUsage {
  $k = Get-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\Count' -ErrorAction SilentlyContinue
  if (-not $k) { return @() }
  $out = New-Object System.Collections.ArrayList
  foreach ($n in $k.GetValueNames()) {
    $b = $k.GetValue($n)
    if (-not ($b -is [byte[]]) -or $b.Length -lt 68) { continue }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $n.ToCharArray()) {
      $c = [int]$ch
      if ($c -ge 65 -and $c -le 90) { [void]$sb.Append([char](65 + ($c - 65 + 13) % 26)) }
      elseif ($c -ge 97 -and $c -le 122) { [void]$sb.Append([char](97 + ($c - 97 + 13) % 26)) }
      else { [void]$sb.Append($ch) }
    }
    $ft = [BitConverter]::ToInt64($b, 60)
    $last = if ($ft -gt 116444736000000000) { [int64](($ft - 116444736000000000) / 10000) } else { 0 }
    [void]$out.Add($sb.ToString() + '|' + [BitConverter]::ToUInt32($b, 4) + '|' + [BitConverter]::ToUInt32($b, 12) + '|' + $last)
  }
  return @($out)
}

# Hardware summary for the System tool (read-only WMI / registry)
function Get-HwInfo {
  $os = Get-CimInstance Win32_OperatingSystem
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
  # VRAM: WMI AdapterRAM is capped at 4 GB; the exact value is in the driver registry key (qwMemorySize)
  $vram = @{}
  Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.DriverDesc -and $p.'HardwareInformation.qwMemorySize') { $vram[$p.DriverDesc] = [int64]$p.'HardwareInformation.qwMemorySize' }
  }
  $gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Microsoft Basic|Remote|Virtual|Parsec|Meta' } | ForEach-Object {
    $mem = if ($vram.ContainsKey($_.Name)) { $vram[$_.Name] } else { [int64]$_.AdapterRAM }
    [ordered]@{ name = $_.Name; vram = $mem; driver = $_.DriverVersion; w = $_.CurrentHorizontalResolution; h = $_.CurrentVerticalResolution; hz = $_.CurrentRefreshRate }
  })
  $types = @{ 20 = 'DDR'; 21 = 'DDR2'; 24 = 'DDR3'; 26 = 'DDR4'; 34 = 'DDR5'; 35 = 'LPDDR5' }
  $sticks = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
    $t = [int]$_.SMBIOSMemoryType
    [ordered]@{ size = [int64]$_.Capacity; speed = $(if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }); type = $(if ($types.ContainsKey($t)) { $types[$t] } else { '' }); maker = ([string]$_.Manufacturer).Trim(); part = ([string]$_.PartNumber).Trim(); slot = $_.DeviceLocator }
  })
  $slots = (Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object -Property MemoryDevices -Sum).Sum
  $disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { [ordered]@{ model = ([string]$_.Model).Trim(); size = [int64]$_.Size; bus = $_.InterfaceType } })
  $vols = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ id = $_.DeviceID; label = $_.VolumeName; size = [int64]$_.Size; free = [int64]$_.FreeSpace } })
  $sysdisk = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ model = ([string]$_.FriendlyName).Trim(); media = [string]$_.MediaType; bus = [string]$_.BusType } })
  [ordered]@{
    os = [ordered]@{ name = $os.Caption; ver = $cv.DisplayVersion; build = $os.BuildNumber + '.' + $cv.UBR; arch = $os.OSArchitecture }
    cpu = [ordered]@{ name = ([string]$cpu.Name).Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; mhz = $cpu.MaxClockSpeed }
    board = [ordered]@{ maker = ([string]$board.Manufacturer).Trim(); model = ([string]$board.Product).Trim() }
    gpus = $gpus; ram = $sticks; slots = $slots; disks = $disks; pdisks = $sysdisk; vols = $vols
  }
}

function Reply($id, $ok, $data) {
  $o = [ordered]@{ id = $id; ok = $ok; data = $data }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

Reply 0 $true 'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ', 3)
  $id = $parts[0]; $cmd = $parts[1]; $arg = if ($parts.Count -gt 2) { $parts[2] } else { '' }
  try {
    $data = switch ($cmd) {
      'audio'    { [ordered]@{ volume = [Math]::Round([Bar.Audio]::GetVolume() * 100); muted = [Bar.Audio]::GetMute(0); mic = [Bar.Audio]::HasMic(); micMuted = $(if ([Bar.Audio]::HasMic()) { [Bar.Audio]::GetMute(1) } else { $false }) } }
      'waitaudio' { $w = $arg.Split(' '); [Bar.Audio]::WaitChange([int]$w[0], [int]$w[1], [int]$w[2], [int]$w[3]) }
      'setvol'   { [Bar.Audio]::SetVolume([float]$arg / 100); $true }
      'mute'     { [Bar.Audio]::SetMute(0, $arg -eq '1'); $true }
      'micmute'  { [Bar.Audio]::SetMute(1, $arg -eq '1'); $true }
      'layout'   { [Bar.Win]::Layout() }
      'layouts'  { @([Bar.Win]::Layouts()) }
      'fg'       { [Bar.Win]::Foreground() }
      'gamestate' { [Bar.Win]::GameState() }
      'fgmax'    { [Bar.Win]::FgMaximized() }
      'gpu'      { [Bar.Gpu]::Usage() }
      'appicon'  { [Bar.ShellIcon]::Png($arg, 64) }
      'winicon'  {
        # PNG (base64) иконки окна запущенной программы с этим exe; иначе пусто
        $want = $arg.ToLower(); $png = $null
        foreach ($w in [Bar.Win]::Windows()) {
          $p = $w.Split('|'); if ($p.Count -lt 3 -or $p[2].ToLower() -ne $want) { continue }
          $hi = [Bar.Win]::WindowIcon([long]$p[0]); if ($hi -eq 0) { continue }
          Add-Type -AssemblyName System.Drawing
          $bmp = ([Drawing.Icon]::FromHandle([IntPtr]$hi)).ToBitmap()
          $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
          $png = [Convert]::ToBase64String($ms.ToArray()); $bmp.Dispose(); break
        }
        $png
      }
      'setlayout' { [Bar.Win]::SetLayout([long]$arg) }
      'windows'  { @([Bar.Win]::Windows()) }
      'focus'    { [Bar.Win]::Focus([long]$arg) }
      'minimize' { [Bar.Win]::Minimize([long]$arg); $true }
      'hidepid'  { [Bar.Win]::HideProcess([int]$arg) }
      'showpid'  { [Bar.Win]::ShowProcess([int]$arg) }
      'close'    { $p = Get-Process -Id ([int]$arg) -ErrorAction Stop; $p.CloseMainWindow() }
      'media'    { Get-NowPlaying }
      'mediactl' { Invoke-Media $arg }
      'bt'       { @(Get-BtBatteries) }
      'net'      { Get-NetState }
      'hidbat'   { @([Bar.HidBattery]::Read()) }
      'taskbar'  { [Bar.Taskbar]::AutoHide() }
      'taskwins' { @([Bar.Win]::TaskWindows()) }
      'winthumbs' { @($arg.Split(',') | Where-Object { $_ } | ForEach-Object { $_ + '|' + [Bar.Win]::Thumb([long]$_, 720, 450) }) }
      'monsizes' {
        # физические размеры экранов из EDID: «имя|ширина см|высота см» — чтобы таскбар был одного размера в сантиметрах
        $ids = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue)
        $sz = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue)
        @($ids | ForEach-Object {
          $inst = $_.InstanceName; $name = (($_.UserFriendlyName | Where-Object { $_ } | ForEach-Object { [char]$_ }) -join '').Trim()
          $p = $sz | Where-Object { $_.InstanceName -eq $inst } | Select-Object -First 1
          if ($p -and $name) { $name + '|' + $p.MaxHorizontalImageSize + '|' + $p.MaxVerticalImageSize }
        })
      }
      'camlist'  { @([Bar.Cam]::List()) }
      'camset'   { $w = $arg.Split(' '); [Bar.Cam]::Set([int]$w[0], [int]$w[1], [int]$w[2], [int]$w[3]) }
      'closewin' { [Bar.Win]::CloseWindow([long]$arg) }
      'startmenu' { [Bar.Win]::StartMenu(); $true }
      'showdesktop' { [Bar.Win]::ShowDesktop(); $true }
      'hidetaskbar' { [Bar.Taskbar]::Hide($arg -eq '1') }
      'appbar'   { $w = $arg.Split(' '); [Bar.Taskbar]::AppBarSet([long]$w[0], [int]$w[1], [int]$w[2], [int]$w[3], [int]$w[4], [int]$w[5]) }
      'appbarnew' { $w = $arg.Split(' '); [Bar.Taskbar]::AppBarNew([long]$w[0], [int]$w[1]); $true }
      'appbaroff' { [Bar.Taskbar]::AppBarRemove([long]$arg); $true }
      'settaskbar' { [Bar.Taskbar]::SetAutoHide($arg -eq '1'); [Bar.Taskbar]::AutoHide() }
      'appxlogo' {
        $fam = $arg; $i = $fam.LastIndexOf('_'); $name = if ($i -gt 0) { $fam.Substring(0, $i) } else { $fam }
        $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $pkg) { $null } else {
          [xml]$m = Get-Content -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -Raw
          $ve = @($m.Package.Applications.Application)[0].VisualElements
          $rel = if ($ve.Square44x44Logo) { $ve.Square44x44Logo } else { $ve.Square150x150Logo }
          if (-not $rel) { $rel = $m.Package.Properties.Logo }
          $full = Join-Path $pkg.InstallLocation $rel
          $dir = Split-Path $full; $base = [IO.Path]::GetFileNameWithoutExtension($full)
          $cands = @(Get-ChildItem -LiteralPath $dir -Filter "$base*.png" -ErrorAction SilentlyContinue)
          $pick = $cands | Where-Object Name -match 'targetsize-48(_altform-unplated)?\.png$' | Select-Object -First 1
          if (-not $pick) { $pick = $cands | Where-Object Name -match 'targetsize-(32|64|40|44)' | Select-Object -First 1 }
          if (-not $pick) { $pick = $cands | Where-Object Name -match 'scale-(200|150|100)' | Select-Object -First 1 }
          if (-not $pick) { $pick = $cands | Select-Object -First 1 }
          if (-not $pick -and (Test-Path -LiteralPath $full)) { $full } elseif ($pick) { $pick.FullName } else { $null }
        }
      }
      'usage'    { @(Get-AppUsage) }
      'hwinfo'   { Get-HwInfo }
      # освободить память после тяжёлых запросов (списки приложений, Bluetooth): сборка мусора + сброс рабочего набора
      'trim'     { [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); $pr = [Diagnostics.Process]::GetCurrentProcess(); $pr.MinWorkingSet = $pr.MinWorkingSet; [Math]::Round($pr.PrivateMemorySize64 / 1MB) }
      'startapps' { @(Get-StartApps | ForEach-Object { $_.Name + '|' + $_.AppID }) }
      'findfiles' {
        # запрос приходит в base64 (UTF-8), чтобы кириллица и пробелы не ломали строковый протокол
        $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
        $words = @($q.ToLower() -split '\s+' | ForEach-Object { $_ -replace '[^\p{L}\p{N}\.\-]', '' } | Where-Object { $_ })
        if ($words.Count -eq 0) { @() } else {
          try {
            if (-not $script:SearchConn) {
              $script:SearchConn = New-Object System.Data.OleDb.OleDbConnection "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"
              $script:SearchConn.Open()
            }
            $cond = ($words | ForEach-Object { "System.FileName LIKE '%" + $_ + "%'" }) -join ' AND '
            $c = $script:SearchConn.CreateCommand()
            $c.CommandText = "SELECT TOP 30 System.ItemUrl, System.ItemType FROM SystemIndex WHERE SCOPE='file:' AND $cond AND NOT System.ItemUrl LIKE '%/AppData/%' AND NOT System.ItemUrl LIKE '%/Start Menu/%' ORDER BY System.DateModified DESC"
            $r = $c.ExecuteReader(); $out = New-Object System.Collections.ArrayList
            try { while ($r.Read()) { $u = [string]$r[0]; if ($u.StartsWith('file:')) { [void]$out.Add($u.Substring(5).Replace('/', '\') + '|' + [string]$r[1]) } } } finally { $r.Close() }
            @($out)
          } catch { $script:SearchConn = $null; throw }
        }
      }
      default    { throw "unknown command $cmd" }
    }
    Reply $id $true $data
  } catch {
    Reply $id $false ($_.Exception.Message)
  }
}
