import { Box, Group, Text } from '@mantine/core'

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Box className="brand-mark" aria-hidden="true">
        <span />
      </Box>
      {!compact && (
        <Text className="brand-name" component="span">
          Better Pet Door
        </Text>
      )}
    </Group>
  )
}
