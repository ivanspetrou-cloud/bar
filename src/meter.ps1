# Bar — уровень звука на выходе для «живого» эквалайзера. Печатает "M <пик 0..1>" ~20 раз в секунду.
# Только чтение пикового уровня из Windows (IAudioMeterInformation): ни звука, ни данных наружу. Останавливается вместе с процессом.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
namespace BarMeter {
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation { int GetPeakValue(out float pfPeak); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  public static class Meter {
    public static void Run(int stepMs) {
      IAudioMeterInformation meter = null; long at = 0;
      var inv = System.Globalization.CultureInfo.InvariantCulture;
      var sw = Stopwatch.StartNew();
      while (true) {
        float p = 0;
        try {
          if (meter == null || sw.ElapsedMilliseconds - at > 3000) { // устройство вывода могли сменить
            var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
            IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
            Guid iid = typeof(IAudioMeterInformation).GUID; object o;
            Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
            meter = (IAudioMeterInformation)o; at = sw.ElapsedMilliseconds;
          }
          meter.GetPeakValue(out p);
        } catch { meter = null; }
        Console.Out.WriteLine("M " + Math.Round(p, 3).ToString(inv));
        Console.Out.Flush();
        Thread.Sleep(stepMs);
      }
    }
  }
}
'@
[BarMeter.Meter]::Run(45)
