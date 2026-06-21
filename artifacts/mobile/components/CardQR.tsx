import React from "react";
import { View } from "react-native";
import QRCode from "react-native-qrcode-svg";

// Premium branded QR: the app logo sits on a white circle in the dead-center of
// the matrix. Error-correction level H tolerates the logo occlusion, and a quiet
// zone keeps scanners happy. Logo footprint stays ~20% of the code so it never
// eats into enough modules to break a scan.
const LOGO = require("../assets/images/icon.png");

export function CardQR({
  value,
  size = 152,
  color = "#0B1A33",
  backgroundColor = "#FFFFFF",
}: {
  value: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
}) {
  const logoSize = Math.round(size * 0.2);
  return (
    <View
      style={{
        backgroundColor,
        borderRadius: 12,
        padding: 10,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <QRCode
        value={value}
        size={size}
        color={color}
        backgroundColor={backgroundColor}
        ecl="H"
        quietZone={6}
        logo={LOGO}
        logoSize={logoSize}
        logoBackgroundColor={backgroundColor}
        logoBorderRadius={logoSize / 2}
        logoMargin={3}
      />
    </View>
  );
}
