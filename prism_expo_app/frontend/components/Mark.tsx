import { View } from 'react-native';
import { t } from '../lib/theme';

/**
 * The PRISM mark: one edge in, refracted bands out.
 *
 * Drawn with plain Views rather than pulling in react-native-svg for two
 * rectangles. Matches the inline SVG in the portal header so the two surfaces
 * are recognisably the same product.
 */
export default function Mark({ size = 22 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        backgroundColor: t.primary,
        overflow: 'hidden',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View
        style={{
          position: 'absolute',
          left: size * 0.26,
          top: -size * 0.2,
          width: size * 0.17,
          height: size * 1.4,
          backgroundColor: '#fff',
          opacity: 0.92,
          transform: [{ rotate: '20deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: size * 0.6,
          top: -size * 0.2,
          width: size * 0.12,
          height: size * 1.4,
          backgroundColor: '#fff',
          opacity: 0.5,
          transform: [{ rotate: '20deg' }],
        }}
      />
    </View>
  );
}
