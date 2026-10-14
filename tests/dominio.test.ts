import { describe, expect, it } from "vitest";
import { isCodigoValido, normalizeDni, normalizePatente } from "../src/domain/validators.js";
import { diffDays, formatApi, parseCalendarDate } from "../src/utils/dates.js";
import { nationalPhone, parsePhoneList, samePhone } from "../src/utils/phones.js";

describe("DNI y patente", () => {
  it("normaliza DNI y CUIT", () => {
    expect(normalizeDni("30.123.456")).toEqual({ ok: true, value: "30123456" });
    expect(normalizeDni("20-38925270-1")).toEqual({ ok: true, value: "38925270" });
    expect(normalizeDni("20-38925270-5").ok).toBe(false); // dígito verificador incorrecto
    expect(normalizeDni("123").ok).toBe(false);
  });

  it("normaliza patentes", () => {
    expect(normalizePatente("aa 123 bb").value).toBe("AA123BB");
    expect(normalizePatente("AF498ZJ").ok).toBe(true);
    expect(normalizePatente("ABCDEFG").ok).toBe(false);
  });

  it("códigos de cliente de 6 dígitos", () => {
    expect(isCodigoValido("000001")).toBe(true);
    expect(isCodigoValido("1")).toBe(false);
  });
});

describe("fechas", () => {
  it("lee los formatos de la API y de los carnets", () => {
    expect(parseCalendarDate("31-12-2027")).toEqual({ year: 2027, month: 12, day: 31 });
    expect(parseCalendarDate("13/11/2026")).toEqual({ year: 2026, month: 11, day: 13 });
    expect(parseCalendarDate("2026-10-08T09:00:00")).toEqual({ year: 2026, month: 10, day: 8 });
  });

  it("rechaza fechas que no existen", () => {
    expect(parseCalendarDate("31-02-2027")).toBeNull();
    expect(parseCalendarDate("00-13-2027")).toBeNull();
    expect(parseCalendarDate("hoy")).toBeNull();
  });

  it("formatea como pide la API (dd-MM-yyyy)", () => {
    expect(formatApi({ year: 2027, month: 1, day: 5 })).toBe("05-01-2027");
    expect(diffDays({ year: 2026, month: 10, day: 14 }, { year: 2026, month: 10, day: 18 })).toBe(4);
  });
});

describe("teléfonos de cargadores", () => {
  it("reconoce el mismo número escrito de distintas formas", () => {
    for (const v of ["2914413200", "+5492914413200", "+54 9 291 441-3200", "0291 15 441-3200", "549 291 4413200"]) {
      expect(nationalPhone(v)).toBe("2914413200");
    }
    expect(samePhone("+5492914413200", "2914413200")).toBe(true);
    expect(samePhone("+5492914413200", "2915719564")).toBe(false);
  });

  it("lee un .txt con comentarios, repetidos y líneas inválidas", () => {
    const r = parsePhoneList("# cargadores\n2914413200\n+5492914413200\n\n291-5719564 ; abc\n");
    expect(r.phones).toEqual(["2914413200", "2915719564"]);
    expect(r.invalid).toEqual(["abc"]);
  });
});
